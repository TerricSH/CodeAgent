Verify each criterion using only visible screenshot evidence.

Return only one JSON object with this shape:

{"checks":[{"criterionIndex":0,"passed":true,"confidence":0.95,"evidence":"visible evidence"}],"summary":"short summary"}

Return exactly one check for every criterion index. `confidence` must be between 0 and 1.

Criteria:

{{criteria}}
