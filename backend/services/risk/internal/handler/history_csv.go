package handler

import (
	"bytes"
	"encoding/csv"
	"net/http"
	"strings"
	"time"

	"firewatch.local/risk/internal/repository"
)

// historyCSVHeader is the frozen column seam of the export, in order. It is the
// document the frontend downloads as-is and the contract in
// contracts/openapi/firewatch-v1.yaml declares, so a rename or a reorder is a
// contract change, not an implementation detail.
//
// Every column is scalar and drawn from a bounded vocabulary: identifiers are
// uuids, the three instants are RFC 3339 UTC rendered here, model_version is a
// registry row, risk_level and data_status are enums, synthetic is yes/no, and
// scenario_id is a compiled-in demonstration profile (or empty for a legacy
// row). The free-text members of a batch — rationale, notice, factors and the
// policy parameters — are deliberately not exported: they are the only values
// this service does not constrain, and a CSV cell is evaluated by a spreadsheet
// rather than merely displayed.
var historyCSVHeader = []string{
	"zone_id",
	"batch_id",
	"job_id",
	"requested_at",
	"published_at",
	"valid_until",
	"model_version",
	"risk_level",
	"data_status",
	"synthetic",
	"scenario_id",
	"evaluated_at",
}

// historyCSV serves the bounded history as a CSV attachment: the same accepted
// zone, the same window, the same order and the same access policy as
// GET /v1/risk/history, rendered instead of JSON. It is a read like its JSON
// sibling and answers through the same readHistory, so it can add no filter and
// drop no row the page already showed.
//
// The body declares its own provenance row by row: zone_id, the publication
// instant published_at, and synthetic (yes/no), derived from the batch's demo
// flag rather than inferred from the environment. The response headers declare
// the same zone and the newest publication instant inside the file, so a saved
// file is attributable after it leaves the page.
//
// An empty history is a valid answer, not a 404: the body is the header row
// alone. A failure is never a CSV document; it is the shared JSON error body of
// the route this one mirrors, answered before any header of this function is
// written.
//
// The format is the one encoding/csv produces with its default settings, and the
// contract documents it that way instead of claiming RFC 4180: UTF-8 text,
// comma-delimited fields, records terminated by a bare LF, fields quoted only
// when they contain a separator, a quote, a CR or an LF, and an embedded quote
// doubled. A CRLF inside a value is therefore written raw inside its quoted
// field, while a Go reader normalises that CRLF to LF when it parses the file, so
// the parsed value and the bytes are not interchangeable.
//
// Cache-Control is set to the no-store directive here. A proxy in front of this
// service may append its own no-store to the same response, so the header is a
// directive that must be present rather than an exact value with one occurrence.
// Content-Disposition is informational for non-browser clients: a browser page
// cannot read it cross-origin unless the proxy exposes it, so the page names the
// downloaded file locally instead.
func historyCSV(store Repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		zone, batches, ok := readHistory(w, r, store)
		if !ok {
			return
		}
		records := make([][]string, 0, len(batches)+1)
		records = append(records, historyCSVHeader)
		var newest time.Time
		for _, batch := range batches {
			if batch.PublishedAt.After(newest) {
				newest = batch.PublishedAt
			}
			records = append(records, historyCSVRecord(batch))
		}
		var body bytes.Buffer
		writer := csv.NewWriter(&body)
		// The destination is an in-memory buffer, whose writes cannot fail, so the
		// encoder is expected to succeed. A failure here would be a defect in this
		// function, not a storage one, and answering 503 would misdescribe it.
		_ = writer.WriteAll(records)

		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Disposition", historyCSVDisposition(zone, newest))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body.Bytes())
	}
}

// historyCSVRecord maps one batch onto the header's columns. The instants are
// canonicalised to UTC and rendered with the same RFC 3339 layout the JSON body
// uses, so a row compares with the JSON member it came from. evaluated_at is
// empty for a legacy row, which is information rather than a guess.
func historyCSVRecord(batch repository.Batch) []string {
	evaluated := ""
	if batch.EvaluatedAt != nil {
		evaluated = batch.EvaluatedAt.UTC().Format(time.RFC3339Nano)
	}
	synthetic := "no"
	if batch.Demo {
		synthetic = "yes"
	}
	return []string{
		csvSafeCell(batch.ZoneID),
		csvSafeCell(batch.ID),
		csvSafeCell(batch.JobID),
		batch.RequestedAt.UTC().Format(time.RFC3339Nano),
		batch.PublishedAt.UTC().Format(time.RFC3339Nano),
		batch.ValidUntil.UTC().Format(time.RFC3339Nano),
		csvSafeCell(batch.ModelVersion),
		csvSafeCell(batch.RiskLevel),
		csvSafeCell(batch.DataStatus),
		synthetic,
		csvSafeCell(batch.ScenarioID),
		evaluated,
	}
}

// csvSafeCell neutralises the one shape encoding/csv cannot defend against: a value
// a spreadsheet reads as a formula instead of as text. The triggers are the four
// symbol prefixes and the leading whitespace a spreadsheet may discard before it
// parses the rest of the cell, which includes a tab, a carriage return and a line
// feed. The columns above are constrained, so no value this service produces can
// start that way; this guard is for the case where one of those constraints is
// defeated upstream. A leading apostrophe makes the cell text to a spreadsheet
// while keeping the original value legible and attributable.
func csvSafeCell(value string) string {
	if value == "" {
		return value
	}
	switch value[0] {
	case '=', '+', '-', '@', '\t', '\r', '\n':
		return "'" + value
	}
	return value
}

// historyCSVDisposition builds the attachment header. The filename is a fixed
// shape that declares the zone and the newest publication instant in the file,
// and it is not taken from the request verbatim: the zone segment is reduced to
// the bytes a filename may carry, so no quote, separator or control byte can
// reach the header. "empty" is how a header-only export declares that it holds
// no publication instant.
func historyCSVDisposition(zone string, newest time.Time) string {
	stamp := "empty"
	if !newest.IsZero() {
		stamp = newest.UTC().Format("20060102T150405Z")
	}
	return `attachment; filename="risk-history-` + csvFilenameSegment(zone) + "-" + stamp + `.csv"`
}

// csvFilenameSegment reduces a validated catalogue zone code to a bounded token for
// the attachment name.
func csvFilenameSegment(zone string) string {
	const limit = 64
	var name strings.Builder
	for _, r := range zone {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			name.WriteRune(r)
		default:
			name.WriteByte('_')
		}
		if name.Len() >= limit {
			break
		}
	}
	if name.Len() == 0 {
		return "zone"
	}
	return name.String()
}
