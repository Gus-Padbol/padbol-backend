BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.crm_conversations ADD COLUMN test_hidden_at timestamptz;
CREATE TABLE public.crm_test_visibility_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid REFERENCES public.crm_conversations(id) ON DELETE SET NULL,
  conversation_reference uuid NOT NULL,
  actor_id uuid,
  action text NOT NULL CHECK (action IN ('hide', 'restore', 'new_message_restore')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.crm_test_visibility_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_test_visibility_audit FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.crm_set_test_visibility(p_id uuid, p_hide boolean, p_actor uuid, p_expected timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE old_hidden timestamptz; old_updated timestamptz;
BEGIN
  IF p_id IS NULL OR p_hide IS NULL OR p_actor IS NULL OR (p_hide AND p_expected IS NULL) THEN RAISE EXCEPTION 'Invalid visibility request' USING ERRCODE='22023'; END IF;
  SELECT test_hidden_at, updated_at INTO old_hidden, old_updated FROM public.crm_conversations WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Conversation not found' USING ERRCODE='P0002'; END IF;
  IF (old_hidden IS NOT NULL) = p_hide THEN RETURN false; END IF;
  IF p_hide AND old_updated IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Conversation changed; review again' USING ERRCODE='40001'; END IF;
  UPDATE public.crm_conversations SET test_hidden_at=CASE WHEN p_hide THEN clock_timestamp() ELSE NULL END WHERE id=p_id;
  INSERT INTO public.crm_test_visibility_audit(conversation_id,conversation_reference,actor_id,action) VALUES(p_id,p_id,p_actor,CASE WHEN p_hide THEN 'hide' ELSE 'restore' END);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.crm_set_test_visibility(uuid,boolean,uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.crm_set_test_visibility(uuid,boolean,uuid,timestamptz) TO service_role;
CREATE FUNCTION public.crm_restore_test_on_inbound() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE prior_hidden timestamptz;
BEGIN
  SELECT test_hidden_at INTO prior_hidden FROM public.crm_conversations WHERE id=NEW.conversation_id FOR UPDATE;
  IF FOUND THEN
    UPDATE public.crm_conversations SET test_hidden_at=NULL, updated_at=greatest(clock_timestamp(),updated_at + interval '1 microsecond') WHERE id=NEW.conversation_id;
    IF prior_hidden IS NOT NULL THEN
      INSERT INTO public.crm_test_visibility_audit(conversation_id,conversation_reference,action) VALUES(NEW.conversation_id,NEW.conversation_id,'new_message_restore');
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.crm_restore_test_on_inbound() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER crm_restore_test_on_inbound AFTER INSERT ON public.crm_inbound_events FOR EACH ROW EXECUTE FUNCTION public.crm_restore_test_on_inbound();
COMMIT;
