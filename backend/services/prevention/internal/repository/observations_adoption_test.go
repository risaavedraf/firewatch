package repository

import (
	"context"
	"errors"
	"testing"

	"firewatch.local/prevention/internal/state"
	"github.com/google/uuid"
)

// PM-10's adoption rules, split the way the implementation is split. The decision
// function is proved without a database because it is the whole rule; the
// transaction around it is proved against a migrated disposable database, because
// only real row locks can show that two confirmations cannot both write. Like the
// rest of this file's siblings, the database tests skip when TEST_DATABASE_URL is
// unset.

// observationFixture stores one observation in a catalogue zone, with a unique
// marker so assertions never depend on rows another run left behind. The
// application role holds no DELETE grant on observations, so there is no cleanup:
// the fixture is identified by its marker, exactly as the PM-09 tests do.
func observationFixture(t *testing.T, ctx context.Context, store Store, marker string) Observation {
	t.Helper()
	code, _ := catalogueZone(t, ctx, store)
	observation, err := store.CreateObservation(ctx, NewObservation{
		Type: "quema", ZoneID: code, ObservedOn: "2026-11-22",
		Description: marker, CreatedBy: "admin-1",
	})
	if err != nil {
		t.Fatalf("create the observation fixture: %v", err)
	}
	return observation
}

// adoptionsFor counts the confirmations stored for one observation.
func adoptionsFor(t *testing.T, ctx context.Context, store Store, observationID string) int {
	t.Helper()
	var count int
	if err := store.DB.QueryRow(ctx, `SELECT count(*) FROM prevention.observation_adoptions WHERE observation_id=$1`, observationID).Scan(&count); err != nil {
		t.Fatalf("count the adoptions of %s: %v", observationID, err)
	}
	return count
}

// TestAdoptionDecisionIsTheSingleLinkRule is the whole relationship rule in one
// table: every non-cancelled action may receive the confirmation, including
// propuesta, porque confirming the need is not assigning or advancing the work;
// a cancelled action refuses a new link; an identical link is answered without
// writing, even after the action was cancelled; and a different action can never
// replace the link that already exists.
func TestAdoptionDecisionIsTheSingleLinkRule(t *testing.T) {
	const (
		first  = "3f2b1c7d-5e6a-4b8c-9d0e-1a2b3c4d5e6f"
		second = "8c9d0e1f-2a3b-4c5d-8e9f-0a1b2c3d4e5f"
	)
	pointer := func(value string) *string { return &value }

	for _, status := range state.States() {
		if status == state.Cancelada {
			continue
		}
		t.Run("fresh link from "+string(status), func(t *testing.T) {
			link, err := adoptionDecision(nil, string(status), first)
			if err != nil || !link {
				t.Fatalf("adoptionDecision(nil, %q) = %v/%v, want a fresh link", status, link, err)
			}
		})
	}

	t.Run("fresh link to a cancelled action", func(t *testing.T) {
		link, err := adoptionDecision(nil, string(state.Cancelada), first)
		if !errors.Is(err, ErrAdoptionActionCancelled) {
			t.Fatalf("adoptionDecision(nil, cancelada) = %v/%v, want ErrAdoptionActionCancelled", link, err)
		}
	})

	t.Run("identical link is answered, not rewritten", func(t *testing.T) {
		link, err := adoptionDecision(pointer(first), string(state.Propuesta), first)
		if err != nil || link {
			t.Fatalf("a repeated identical link = %v/%v, want no write and no error", link, err)
		}
	})

	t.Run("identical link survives the later cancellation", func(t *testing.T) {
		link, err := adoptionDecision(pointer(first), string(state.Cancelada), first)
		if err != nil || link {
			t.Fatalf("a repeat after cancellation = %v/%v, want the durable link answered and nothing written", link, err)
		}
	})

	t.Run("a different action cannot overwrite", func(t *testing.T) {
		for _, status := range []state.State{state.Propuesta, state.Cancelada} {
			link, err := adoptionDecision(pointer(first), string(status), second)
			if !errors.Is(err, ErrObservationAlreadyAdopted) {
				t.Fatalf("linking %s over %s while the action is %s = %v/%v, want ErrObservationAlreadyAdopted", second, first, status, link, err)
			}
		}
	})
}

// TestAdoptionLinksAnExistingActionAndReportsTheDurableAssociation proves the one
// write path against the real database: the link is stored with the verified
// confirmer and the server instant, the observation comes back with
// adopted_action_id, the list PM-09 already serves reports it, and an identical
// repeat answers the durable row without writing a second one.
func TestAdoptionLinksAnExistingActionAndReportsTheDurableAssociation(t *testing.T) {
	ctx, store := testStore(t)
	action := create(t, ctx, store, "valparaiso")
	observation := observationFixture(t, ctx, store, "adoption-link-"+uuid.NewString())

	adopted, err := store.AdoptObservation(ctx, observation.ID, action.ID, "admin-7")
	if err != nil {
		t.Fatalf("adopt: %v", err)
	}
	if !adopted.Recorded {
		t.Error("the first confirmation reported recorded=false")
	}
	if adopted.ActionID != action.ID || adopted.ConfirmedBy != "admin-7" {
		t.Errorf("stored adoption is action=%q confirmed_by=%q, want %q/admin-7", adopted.ActionID, adopted.ConfirmedBy, action.ID)
	}
	if adopted.ConfirmedAt.IsZero() {
		t.Error("confirmed_at is zero; the server clock must stamp it")
	}
	if adopted.Observation.ID != observation.ID || adopted.Observation.Description != observation.Description {
		t.Errorf("the answer is not the stored observation: %+v", adopted.Observation)
	}
	if adopted.Observation.AdoptedActionID == nil || *adopted.Observation.AdoptedActionID != action.ID {
		t.Errorf("adopted_action_id is %v, want %q", adopted.Observation.AdoptedActionID, action.ID)
	}
	if got := adoptionsFor(t, ctx, store, observation.ID); got != 1 {
		t.Fatalf("%d links were stored for the observation, want 1", got)
	}

	listed, err := store.ListObservations(ctx, observation.Type)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	found := false
	for _, candidate := range listed {
		if candidate.ID != observation.ID {
			continue
		}
		found = true
		if candidate.AdoptedActionID == nil || *candidate.AdoptedActionID != action.ID {
			t.Errorf("the list reports adopted_action_id %v, want %q", candidate.AdoptedActionID, action.ID)
		}
	}
	if !found {
		t.Fatal("the linked observation is missing from its own type's list")
	}

	repeated, err := store.AdoptObservation(ctx, observation.ID, action.ID, "another-admin")
	if err != nil {
		t.Fatalf("repeat the identical link: %v", err)
	}
	if repeated.Recorded {
		t.Error("a repeated identical link reported recorded=true")
	}
	if repeated.ConfirmedBy != "admin-7" || !repeated.ConfirmedAt.Equal(adopted.ConfirmedAt) {
		t.Errorf("a repeat reports confirmer %q at %v, want the original %q at %v", repeated.ConfirmedBy, repeated.ConfirmedAt, "admin-7", adopted.ConfirmedAt)
	}
	if repeated.Observation.AdoptedActionID == nil || *repeated.Observation.AdoptedActionID != action.ID {
		t.Errorf("a repeat lost the association: %v", repeated.Observation.AdoptedActionID)
	}
	if got := adoptionsFor(t, ctx, store, observation.ID); got != 1 {
		t.Fatalf("%d links were stored after a repeat, want exactly 1", got)
	}

	// The action is untouched: twenty minutes of confirmation must not assign it,
	// advance it or append a transition. The state machine is not part of this
	// operation.
	detail, err := store.Get(ctx, action.ID)
	if err != nil {
		t.Fatalf("read the action: %v", err)
	}
	if detail.Status != string(state.Propuesta) || detail.AssigneeID != nil || len(detail.History) != 0 {
		t.Errorf("adoption changed the action: status=%q assignee=%v history=%d", detail.Status, detail.AssigneeID, len(detail.History))
	}
}

// TestAdoptionRefusesAConflictingSecondActionWithoutOverwriting proves the "one
// action per observation" half in the database: the second link is refused, the
// first stays byte-identical, and no second row exists to be read later.
func TestAdoptionRefusesAConflictingSecondActionWithoutOverwriting(t *testing.T) {
	ctx, store := testStore(t)
	first := create(t, ctx, store, "valparaiso")
	second := create(t, ctx, store, "valparaiso")
	observation := observationFixture(t, ctx, store, "adoption-conflict-"+uuid.NewString())

	if _, err := store.AdoptObservation(ctx, observation.ID, first.ID, "admin-1"); err != nil {
		t.Fatalf("first adoption: %v", err)
	}
	_, err := store.AdoptObservation(ctx, observation.ID, second.ID, "admin-1")
	if !errors.Is(err, ErrObservationAlreadyAdopted) {
		t.Fatalf("conflicting adoption returned %v, want ErrObservationAlreadyAdopted", err)
	}
	if got := adoptionsFor(t, ctx, store, observation.ID); got != 1 {
		t.Fatalf("%d links exist after a refused conflict, want 1", got)
	}
	var stored string
	if err := store.DB.QueryRow(ctx, `SELECT action_id::text FROM prevention.observation_adoptions WHERE observation_id=$1`, observation.ID).Scan(&stored); err != nil {
		t.Fatalf("read the stored link: %v", err)
	}
	if stored != first.ID {
		t.Errorf("the stored link is %q, want the first action %q", stored, first.ID)
	}
}

// TestCancellationKeepsHistoricalLinksAndRefusesFreshOnes is S4's cancellation
// rule at the database: cancelling the action after the confirmation leaves the
// link readable and a repeat of the identical link is still safe, while a NEW link
// to the cancelled action is refused and writes nothing. Nothing here transitions
// the action: the only history row is the cancellation the test itself asked for.
func TestCancellationKeepsHistoricalLinksAndRefusesFreshOnes(t *testing.T) {
	ctx, store := testStore(t)
	action := create(t, ctx, store, "valparaiso")
	linked := observationFixture(t, ctx, store, "adoption-cancelled-history-"+uuid.NewString())
	fresh := observationFixture(t, ctx, store, "adoption-cancelled-fresh-"+uuid.NewString())

	adopted, err := store.AdoptObservation(ctx, linked.ID, action.ID, "admin-1")
	if err != nil {
		t.Fatalf("adopt before cancellation: %v", err)
	}
	if _, err := store.Transition(ctx, action.ID, string(state.Cancelada), "admin-1", "el trabajo ya no es necesario"); err != nil {
		t.Fatalf("cancel the action: %v", err)
	}

	repeated, err := store.AdoptObservation(ctx, linked.ID, action.ID, "admin-2")
	if err != nil {
		t.Fatalf("repeat the durable link after cancellation: %v", err)
	}
	if repeated.Recorded {
		t.Error("a repeat after cancellation wrote a new confirmation")
	}
	if repeated.Observation.AdoptedActionID == nil || *repeated.Observation.AdoptedActionID != action.ID {
		t.Errorf("cancellation erased the historical link: %v", repeated.Observation.AdoptedActionID)
	}
	if !repeated.ConfirmedAt.Equal(adopted.ConfirmedAt) {
		t.Errorf("the repeat reports confirmed_at %v, want the original %v", repeated.ConfirmedAt, adopted.ConfirmedAt)
	}

	listed, err := store.ListObservations(ctx, linked.Type)
	if err != nil {
		t.Fatalf("list after cancellation: %v", err)
	}
	for _, candidate := range listed {
		if candidate.ID == linked.ID {
			if candidate.AdoptedActionID == nil || *candidate.AdoptedActionID != action.ID {
				t.Errorf("the list dropped the historical link after cancellation: %v", candidate.AdoptedActionID)
			}
		}
	}

	_, err = store.AdoptObservation(ctx, fresh.ID, action.ID, "admin-1")
	if !errors.Is(err, ErrAdoptionActionCancelled) {
		t.Fatalf("a fresh link to a cancelled action returned %v, want ErrAdoptionActionCancelled", err)
	}
	if got := adoptionsFor(t, ctx, store, fresh.ID); got != 0 {
		t.Fatalf("%d rows were written for a refused fresh link, want 0", got)
	}

	detail, err := store.Get(ctx, action.ID)
	if err != nil {
		t.Fatalf("read the action: %v", err)
	}
	if detail.Status != string(state.Cancelada) {
		t.Errorf("the action status became %q; adoption must not transition it", detail.Status)
	}
	if detail.AssigneeID != nil {
		t.Errorf("adoption assigned %v; confirming the need does not assign personnel", *detail.AssigneeID)
	}
	if len(detail.History) != 1 {
		t.Errorf("the action history holds %d rows, want exactly the cancellation", len(detail.History))
	}
}

// TestAdoptionAllowsManyObservationsToBackOneAction is the other side of the
// cardinality rule the product selected: several field observations may justify
// the same action, and one observation never justifies more than one.
func TestAdoptionAllowsManyObservationsToBackOneAction(t *testing.T) {
	ctx, store := testStore(t)
	action := create(t, ctx, store, "valparaiso")
	first := observationFixture(t, ctx, store, "adoption-many-first-"+uuid.NewString())
	second := observationFixture(t, ctx, store, "adoption-many-second-"+uuid.NewString())

	for _, observation := range []Observation{first, second} {
		adopted, err := store.AdoptObservation(ctx, observation.ID, action.ID, "admin-1")
		if err != nil {
			t.Fatalf("adopt %s: %v", observation.ID, err)
		}
		if !adopted.Recorded {
			t.Errorf("adopting %s reported recorded=false", observation.ID)
		}
	}
	var count int
	if err := store.DB.QueryRow(ctx, `SELECT count(*) FROM prevention.observation_adoptions WHERE action_id=$1`, action.ID).Scan(&count); err != nil {
		t.Fatalf("count the action's links: %v", err)
	}
	if count != 2 {
		t.Errorf("the action holds %d supporting observations, want 2", count)
	}
}

// adoptionOutcome is one answer of a concurrent adoption, sent over a channel so
// the racing goroutines never share a write.
type adoptionOutcome struct {
	adoption ObservationAdoption
	err      error
}

// raceAdoptions starts one adoption per action at the same moment and collects
// every answer. The barrier is what makes the race real: all goroutines wait on
// the same closed channel, so they contend on the same observation lock.
func raceAdoptions(ctx context.Context, store Store, observationID string, actionIDs []string) []adoptionOutcome {
	start := make(chan struct{})
	done := make(chan adoptionOutcome, len(actionIDs))
	for _, actionID := range actionIDs {
		go func(actionID string) {
			<-start
			adoption, err := store.AdoptObservation(ctx, observationID, actionID, "admin-1")
			done <- adoptionOutcome{adoption: adoption, err: err}
		}(actionID)
	}
	close(start)
	outcomes := make([]adoptionOutcome, 0, len(actionIDs))
	for range actionIDs {
		outcomes = append(outcomes, <-done)
	}
	return outcomes
}

// TestConcurrentAdoptionsSerializeOnTheObservation proves the concurrency half of
// S4's risk: two confirmations of the same observation cannot both write. Two
// identical links both succeed and exactly one is recorded; two conflicting links
// leave exactly one winner and the loser is refused, never silently overwriting.
func TestConcurrentAdoptionsSerializeOnTheObservation(t *testing.T) {
	ctx, store := testStore(t)

	t.Run("identical", func(t *testing.T) {
		action := create(t, ctx, store, "valparaiso")
		observation := observationFixture(t, ctx, store, "adoption-race-identical-"+uuid.NewString())
		outcomes := raceAdoptions(ctx, store, observation.ID, []string{action.ID, action.ID})
		recorded := 0
		for index, outcome := range outcomes {
			if outcome.err != nil {
				t.Fatalf("concurrent identical adoption %d returned %v", index, outcome.err)
			}
			if outcome.adoption.Recorded {
				recorded++
			}
			linked := outcome.adoption.Observation.AdoptedActionID
			if linked == nil || *linked != action.ID {
				t.Errorf("concurrent answer %d lost the association: %v", index, linked)
			}
		}
		if recorded != 1 {
			t.Errorf("%d of the concurrent identical adoptions recorded a row, want exactly 1", recorded)
		}
		if got := adoptionsFor(t, ctx, store, observation.ID); got != 1 {
			t.Errorf("%d links exist after the race, want 1", got)
		}
	})

	t.Run("conflicting", func(t *testing.T) {
		first := create(t, ctx, store, "valparaiso")
		second := create(t, ctx, store, "valparaiso")
		observation := observationFixture(t, ctx, store, "adoption-race-conflict-"+uuid.NewString())
		outcomes := raceAdoptions(ctx, store, observation.ID, []string{first.ID, second.ID})
		winners := 0
		for index, outcome := range outcomes {
			switch {
			case outcome.err == nil:
				winners++
			case errors.Is(outcome.err, ErrObservationAlreadyAdopted):
			default:
				t.Fatalf("concurrent conflicting adoption %d returned %v, want nil or ErrObservationAlreadyAdopted", index, outcome.err)
			}
		}
		if winners != 1 {
			t.Fatalf("%d concurrent conflicting adoptions succeeded, want exactly 1", winners)
		}
		if got := adoptionsFor(t, ctx, store, observation.ID); got != 1 {
			t.Errorf("%d links exist after the conflict, want 1", got)
		}
		var stored string
		if err := store.DB.QueryRow(ctx, `SELECT action_id::text FROM prevention.observation_adoptions WHERE observation_id=$1`, observation.ID).Scan(&stored); err != nil {
			t.Fatalf("read the stored link: %v", err)
		}
		if stored != first.ID && stored != second.ID {
			t.Errorf("the stored link %q is neither of the two requested actions", stored)
		}
	})
}

// TestAdoptionRefusesAnUnknownObservationOrAction proves the two existence checks
// of the transaction: the observation is the addressed resource (its own error, the
// route's 404) and the action is a body reference (the 422 an unresolved
// assignee_id or zone_id also uses). In both cases nothing is written.
func TestAdoptionRefusesAnUnknownObservationOrAction(t *testing.T) {
	ctx, store := testStore(t)
	action := create(t, ctx, store, "valparaiso")
	observation := observationFixture(t, ctx, store, "adoption-missing-"+uuid.NewString())

	if _, err := store.AdoptObservation(ctx, uuid.NewString(), action.ID, "admin-1"); !errors.Is(err, ErrObservationNotFound) {
		t.Fatalf("adopting from an unknown observation returned %v, want ErrObservationNotFound", err)
	}
	_, err := store.AdoptObservation(ctx, observation.ID, uuid.NewString(), "admin-1")
	if !errors.Is(err, ErrAdoptionActionNotFound) {
		t.Fatalf("adopting an unknown action returned %v, want ErrAdoptionActionNotFound", err)
	}
	if got := adoptionsFor(t, ctx, store, observation.ID); got != 0 {
		t.Errorf("%d rows were written by the refused adoptions, want 0", got)
	}
	var rows int
	if err := store.DB.QueryRow(ctx, `SELECT count(*) FROM prevention.observation_adoptions WHERE action_id=$1`, action.ID).Scan(&rows); err != nil {
		t.Fatalf("count the action's links: %v", err)
	}
	if rows != 0 {
		t.Errorf("%d links exist for an action that was only named, want 0", rows)
	}
}

// TestAdoptionGrantsAreAppendOnlyForTheApplicationRole proves the migration's
// grants against the role the service actually connects as: it may read and append
// confirmations, never rewrite or delete one, and the observations table itself
// keeps the PM-09 append-only posture with no UPDATE grant that a column-based
// association would have required.
func TestAdoptionGrantsAreAppendOnlyForTheApplicationRole(t *testing.T) {
	ctx, store := testStore(t)
	var canSelect, canInsert, canUpdate, canDelete bool
	if err := store.DB.QueryRow(ctx, `SELECT
		has_table_privilege(current_user,'prevention.observation_adoptions','SELECT'),
		has_table_privilege(current_user,'prevention.observation_adoptions','INSERT'),
		has_table_privilege(current_user,'prevention.observation_adoptions','UPDATE'),
		has_table_privilege(current_user,'prevention.observation_adoptions','DELETE')`).
		Scan(&canSelect, &canInsert, &canUpdate, &canDelete); err != nil {
		t.Fatalf("read the adoption grants: %v", err)
	}
	if !canSelect || !canInsert {
		t.Errorf("runtime role may select=%v and insert=%v confirmations, want true/true", canSelect, canInsert)
	}
	if canUpdate || canDelete {
		t.Errorf("runtime role may update=%v and delete=%v confirmations; the table must stay append-only", canUpdate, canDelete)
	}
	var observationUpdate bool
	if err := store.DB.QueryRow(ctx, `SELECT has_table_privilege(current_user,'prevention.observations','UPDATE')`).Scan(&observationUpdate); err != nil {
		t.Fatalf("read the observation grant: %v", err)
	}
	if observationUpdate {
		t.Error("the observations table gained UPDATE; the association must not need rewriting a stored observation")
	}
}

// TestAdoptionDatabaseRefusesOrphansAndDuplicateLinks proves the referential
// integrity the migration adds, from the database side and bypassing the service:
// a link to an unknown observation or action is refused, a second link for one
// observation is refused, and confirmed_by cannot be blank.
func TestAdoptionDatabaseRefusesOrphansAndDuplicateLinks(t *testing.T) {
	ctx, store := testStore(t)
	action := create(t, ctx, store, "valparaiso")
	observation := observationFixture(t, ctx, store, "adoption-integrity-"+uuid.NewString())

	if _, err := store.AdoptObservation(ctx, observation.ID, action.ID, "admin-1"); err != nil {
		t.Fatalf("adopt: %v", err)
	}

	for name, statement := range map[string]string{
		"unknown observation": `INSERT INTO prevention.observation_adoptions(observation_id,action_id,confirmed_by) VALUES($1,$2,'tester')`,
		"unknown action":      `INSERT INTO prevention.observation_adoptions(observation_id,action_id,confirmed_by) VALUES($1,$2,'tester')`,
	} {
		t.Run(name, func(t *testing.T) {
			observationID, actionID := uuid.NewString(), action.ID
			if name == "unknown observation" {
				observationID = uuid.NewString()
			} else {
				observationID = observationFixture(t, ctx, store, "adoption-integrity-orphan-"+uuid.NewString()).ID
				actionID = uuid.NewString()
			}
			if _, err := store.DB.Exec(ctx, statement, observationID, actionID); err == nil {
				t.Fatalf("%s was accepted; the foreign key must refuse it", name)
			}
		})
	}

	second := create(t, ctx, store, "valparaiso")
	_, err := store.DB.Exec(ctx, `INSERT INTO prevention.observation_adoptions(observation_id,action_id,confirmed_by) VALUES($1,$2,'tester')`, observation.ID, second.ID)
	if err == nil {
		t.Fatal("a second link for the same observation was accepted; the primary key must refuse it")
	}

	_, err = store.DB.Exec(ctx, `INSERT INTO prevention.observation_adoptions(observation_id,action_id,confirmed_by) VALUES($1,$2,'   ')`,
		observationFixture(t, ctx, store, "adoption-integrity-blank-"+uuid.NewString()).ID, action.ID)
	if err == nil {
		t.Fatal("a blank confirmer was accepted; confirmed_by must stay non-blank")
	}
}
