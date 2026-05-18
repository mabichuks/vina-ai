-- 005_tailored_pdf_paths.sql
-- Adds parallel pdf paths so the manual-apply pipeline can render the tailored
-- CV (and optional cover letter) in both .docx and .pdf at the same time. The
-- Ready-to-Apply UI offers a download dropdown — DOC for editing, PDF for
-- archives / portfolios.

ALTER TABLE applications ADD COLUMN tailored_cv_pdf_path TEXT;
ALTER TABLE applications ADD COLUMN tailored_cover_letter_pdf_path TEXT;
