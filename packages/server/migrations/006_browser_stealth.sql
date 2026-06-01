-- Opt-in anti-detection / stealth masking (ADR-021). Off by default;
-- behaviour is unchanged until the user enables it in Settings.

ALTER TABLE settings
  ADD COLUMN browser_stealth INTEGER NOT NULL DEFAULT 0
  CHECK (browser_stealth IN (0, 1));
