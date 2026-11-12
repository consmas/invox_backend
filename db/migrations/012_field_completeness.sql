-- Field completeness: the organisation contact person's title was specified for every profile type but
-- had no column. Additive and nullable; existing profiles keep NULL until the title is known.
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS contact_title varchar(200);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_title varchar(200);
ALTER TABLE financier_profiles ADD COLUMN IF NOT EXISTS contact_title varchar(200);
