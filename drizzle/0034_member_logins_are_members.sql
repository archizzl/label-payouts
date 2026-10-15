-- A band member's own login on a band account is a member, not an admin: only the band's shared login (and the label) manage who can sign in.
UPDATE "member" AS m SET role = 'member'
FROM "band_login_people" AS b
WHERE b.org_id = m.organization_id AND b.user_id = m.user_id AND m.role <> 'member';
