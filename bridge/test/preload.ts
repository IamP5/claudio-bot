// No test may reach the real claude CLI or start a cloud agent: an unset CLAUDIOBOT_CLAUDE resolves to an executable
// that exits non-zero. A test that needs a claude sets its own fake and restores this one.
process.env.CLAUDIOBOT_CLAUDE ??= "/usr/bin/false";
