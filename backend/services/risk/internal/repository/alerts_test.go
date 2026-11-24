package repository

import "testing"

// TestAlertPolicyRaisesAnAlertOnEveryChangeBetweenDeterminedLevels is the S1/S2
// table: an ascent alerts, a descent alerts, and nothing else does. `desconocido`
// records that the inputs were insufficient, so it is not a severity and never
// takes part in a transition; a value that is not one of the three determined
// levels is refused the same way instead of being ranked by accident.
func TestAlertPolicyRaisesAnAlertOnEveryChangeBetweenDeterminedLevels(t *testing.T) {
	cases := []struct {
		name     string
		previous string
		next     string
		want     bool
	}{
		{"ascent bajo to medio", "bajo", "medio", true},
		{"ascent medio to alto", "medio", "alto", true},
		{"ascent bajo to alto", "bajo", "alto", true},
		{"descent medio to bajo", "medio", "bajo", true},
		{"descent alto to medio", "alto", "medio", true},
		{"descent alto to bajo", "alto", "bajo", true},
		{"no change bajo", "bajo", "bajo", false},
		{"no change medio", "medio", "medio", false},
		{"no change alto", "alto", "alto", false},
		{"previous level unknown", "desconocido", "alto", false},
		{"next level unknown", "medio", "desconocido", false},
		{"both levels unknown", "desconocido", "desconocido", false},
		{"no previous level", "", "alto", false},
		{"non-canonical next level", "alto", "extremo", false},
		{"non-canonical previous level", "extremo", "alto", false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := levelChangeAlerts(testCase.previous, testCase.next); got != testCase.want {
				t.Fatalf("levelChangeAlerts(%q, %q) = %t, want %t", testCase.previous, testCase.next, got, testCase.want)
			}
		})
	}
}

// TestAlertThresholdIsOneDeterminedStep pins the agreed value. S1 requires the
// threshold to be a declared value rather than a hidden literal, and S2 defines
// the policy as "an alert on any ascent or descent between known levels": one
// severity step is the smallest change two determined levels can have, so a
// threshold above one would drop exactly the changes the policy requires. The
// same value is written into the column default of 017_risk_alerts.sql.
func TestAlertThresholdIsOneDeterminedStep(t *testing.T) {
	if AlertLevelChangeThreshold != 1 {
		t.Fatalf("AlertLevelChangeThreshold = %d, want the agreed 1: a level change is at least one step", AlertLevelChangeThreshold)
	}
	// Every single-step move in both directions crosses the threshold, and the
	// threshold is the bound the policy is expressed with, not a special case.
	for _, step := range []struct{ from, to string }{
		{"bajo", "medio"},
		{"medio", "alto"},
		{"alto", "medio"},
		{"medio", "bajo"},
	} {
		if !levelChangeAlerts(step.from, step.to) {
			t.Fatalf("the %s to %s step did not cross the agreed threshold", step.from, step.to)
		}
	}
}
