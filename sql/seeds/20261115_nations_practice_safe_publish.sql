-- ROOT-ONLY reviewable publish wrapper. Do not run on production until gate.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.torneos WHERE id=1000000000001)
     OR EXISTS (SELECT 1 FROM public.partidos WHERE id IN (1000000000101,1000000000102,1000000000103))
  THEN RAISE EXCEPTION 'PRACTICE_ID_COLLISION_WITH_PUBLIC'; END IF;
  IF EXISTS (SELECT 1 FROM nations_practice.events WHERE virtual_torneo_id=1000000000001) THEN
    RAISE EXCEPTION 'PRACTICE_ALREADY_SEEDED';
  END IF;
END $$;
\i sql/seeds/20261115_nations_practice_synthetic.sql
COMMIT;
-- Post-check expected: 6 teams, 24 players, 3 matches, 3 boards, zero public writes.
