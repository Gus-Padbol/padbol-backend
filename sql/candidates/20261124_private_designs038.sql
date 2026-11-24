-- LOCAL candidate038: private PP projects only. No assets uploaded, no old rows changed.
BEGIN;
CREATE TABLE public.content_design_projects(
 id uuid PRIMARY KEY,sede_id bigint NOT NULL REFERENCES public.sedes(id),version bigint NOT NULL CHECK(version>0),
 base_entry_id uuid NOT NULL REFERENCES public.content_library_entries(id),base_source_version bigint NOT NULL CHECK(base_source_version>0),base_file_id uuid NOT NULL REFERENCES public.content_workspace_files(id),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),created_by uuid NOT NULL,updated_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX content_design_projects_pp ON public.content_design_projects(sede_id,updated_at DESC,id);
CREATE TABLE public.content_design_operations(
 project_id uuid NOT NULL REFERENCES public.content_design_projects(id),version bigint NOT NULL,
 actor_id uuid NOT NULL,sede_id bigint NOT NULL,operation_key uuid NOT NULL,canonical_payload jsonb NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,version),UNIQUE(actor_id,sede_id,operation_key)
);
ALTER TABLE public.content_design_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_design_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.content_design_projects,public.content_design_operations FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.content_design_immutable038() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$BEGIN RAISE EXCEPTION 'CONTENT_DESIGN_IMMUTABLE';END$$;
CREATE TRIGGER content_design_history_immutable BEFORE UPDATE OR DELETE ON public.content_design_operations FOR EACH ROW EXECUTE FUNCTION public.content_design_immutable038();
CREATE TRIGGER content_design_project_no_delete BEFORE DELETE ON public.content_design_projects FOR EACH ROW EXECUTE FUNCTION public.content_design_immutable038();
CREATE FUNCTION public.content_design_owner038() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$BEGIN IF NEW.id IS DISTINCT FROM OLD.id OR NEW.sede_id IS DISTINCT FROM OLD.sede_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'CONTENT_DESIGN_IMMUTABLE';END IF;RETURN NEW;END$$;
CREATE TRIGGER content_design_owner_immutable BEFORE UPDATE ON public.content_design_projects FOR EACH ROW EXECUTE FUNCTION public.content_design_owner038();
CREATE FUNCTION public.content_design_dto038(p public.content_design_projects) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('id',p.id,'sedeId',p.sede_id,'version',p.version,'document',p.document,'createdAt',p.created_at,'updatedAt',p.updated_at)
$$;
CREATE FUNCTION public.content_design_base038(p_sede bigint,p_entry uuid,p_version bigint) RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE item_id uuid; result uuid;
BEGIN
 SELECT e.item_id INTO item_id FROM public.content_library_entries e WHERE e.id=p_entry;
 IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_DESIGN_BASE_UNAVAILABLE';END IF;
 PERFORM 1 FROM public.content_workspace_items i WHERE i.id=item_id FOR SHARE;
 SELECT f.id INTO result FROM public.content_library_entries e
 JOIN public.content_workspace_items i ON i.id=e.item_id
 JOIN public.content_workspace_files f ON f.id=e.file_id AND f.item_id=i.id
 JOIN public.content_library_categories c ON c.sede_id=p_sede AND c.category_key=e.category_key
 WHERE e.id=p_entry AND e.enabled AND c.enabled AND e.source_version=p_version AND i.version=p_version
 AND i.payload->>'status' IN('aprobado','publicado') AND i.payload->>'assetKind' IN('original','textless')
 AND f.mime_type IN('image/png','image/jpeg','image/webp','image/gif')
 FOR SHARE OF e,c;
 IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_DESIGN_BASE_UNAVAILABLE';END IF;
 RETURN result;
END$$;
CREATE FUNCTION public.content_design_command038(p_actor uuid,p_sede bigint,p_action text,p_project_id uuid DEFAULT NULL,p_expected bigint DEFAULT NULL,p_document jsonb DEFAULT NULL,p_operation_key uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE rr record; role_count integer:=0; actor_role text; actor_sede bigint; pr public.content_design_projects; previous public.content_design_projects; op public.content_design_operations; canonical jsonb; base_file uuid; result jsonb; req_entry uuid;req_version bigint;
BEGIN
 -- Fixed authority order: persisted actor rows -> workspace items -> entry/grant -> project.
 FOR rr IN SELECT role,sede_id FROM public.user_roles WHERE user_id=p_actor ORDER BY id FOR SHARE LOOP role_count:=role_count+1;actor_role:=rr.role;actor_sede:=rr.sede_id;END LOOP;
 IF role_count<>1 OR actor_role NOT IN('super_admin','admin_club') OR p_sede IS NULL OR p_sede<=0 OR (actor_role='admin_club' AND actor_sede IS DISTINCT FROM p_sede) THEN RAISE EXCEPTION 'CONTENT_DESIGN_FORBIDDEN';END IF;
 IF p_action='list' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'sedeId',x.sede_id,'title',x.document->>'title','format',x.document->>'format','version',x.version,'baseEntryId',x.base_entry_id,'baseSourceVersion',x.base_source_version,'updatedAt',x.updated_at) ORDER BY x.updated_at DESC,x.id),'[]'::jsonb) INTO result FROM(
   SELECT p.* FROM public.content_design_projects p JOIN public.content_library_entries e ON e.id=p.base_entry_id
   JOIN public.content_workspace_items i ON i.id=e.item_id JOIN public.content_workspace_files f ON f.id=e.file_id AND f.item_id=i.id
   JOIN public.content_library_categories c ON c.category_key=e.category_key AND c.sede_id=p_sede
   WHERE p.sede_id=p_sede AND e.enabled AND c.enabled AND e.source_version=p.base_source_version AND i.version=p.base_source_version
   AND i.payload->>'status' IN('aprobado','publicado') AND i.payload->>'assetKind' IN('original','textless') AND f.mime_type IN('image/png','image/jpeg','image/webp','image/gif')
   ORDER BY i.id,e.id,p.id LIMIT 100 FOR SHARE OF i,e,c,p
  ) x;
  RETURN jsonb_build_object('projects',result);
 END IF;
 IF p_action NOT IN('read','save') OR p_project_id IS NULL THEN RAISE EXCEPTION 'CONTENT_DESIGN_INVALID';END IF;
 SELECT * INTO previous FROM public.content_design_projects WHERE id=p_project_id;
 IF FOUND AND previous.sede_id<>p_sede THEN RAISE EXCEPTION 'CONTENT_DESIGN_FORBIDDEN';END IF;
 IF p_action='read' AND previous.id IS NULL THEN RAISE EXCEPTION 'CONTENT_DESIGN_NOT_FOUND';END IF;
 IF p_action='save' THEN
  IF p_expected IS NULL OR p_expected<0 OR p_operation_key IS NULL OR jsonb_typeof(p_document)<>'object' OR p_document->>'schemaVersion'<>'1' OR jsonb_typeof(p_document->'layers')<>'array' OR p_document->>'format' NOT IN('historia','feed','carrusel','torneo_app') THEN RAISE EXCEPTION 'CONTENT_DESIGN_INVALID';END IF;
  req_entry:=(p_document->>'baseEntryId')::uuid;req_version:=(p_document->>'baseSourceVersion')::bigint;
  IF req_entry IS NULL OR req_version IS NULL OR req_version<1 THEN RAISE EXCEPTION 'CONTENT_DESIGN_INVALID';END IF;
 END IF;
 -- Sorting all old/new backgrounds before lower-level locks prevents inverted base changes.
 PERFORM 1 FROM public.content_workspace_items WHERE id IN(SELECT item_id FROM public.content_library_entries WHERE id=ANY(ARRAY[previous.base_entry_id,req_entry])) ORDER BY id FOR SHARE;
 IF previous.id IS NOT NULL THEN PERFORM public.content_design_base038(p_sede,previous.base_entry_id,previous.base_source_version);END IF;
 IF p_action='save' THEN base_file:=public.content_design_base038(p_sede,req_entry,req_version);END IF;
 -- Project namespace also serializes create/retry before a row exists.
 PERFORM pg_advisory_xact_lock(hashtextextended('content-design038:'||p_project_id::text,0));
 SELECT * INTO pr FROM public.content_design_projects WHERE id=p_project_id FOR UPDATE;
 IF FOUND AND pr.sede_id<>p_sede THEN RAISE EXCEPTION 'CONTENT_DESIGN_FORBIDDEN';END IF;
 IF previous.id IS NOT NULL AND (pr.version IS DISTINCT FROM previous.version OR pr.base_entry_id IS DISTINCT FROM previous.base_entry_id OR pr.base_source_version IS DISTINCT FROM previous.base_source_version) THEN RAISE EXCEPTION 'CONTENT_DESIGN_VERSION_CONFLICT';END IF;
 IF p_action='read' THEN
  RETURN jsonb_build_object('project',public.content_design_dto038(pr),'history',coalesce((SELECT jsonb_agg(jsonb_build_object('version',version,'operationKey',operation_key,'actorId',actor_id,'createdAt',created_at) ORDER BY version DESC) FROM public.content_design_operations WHERE project_id=pr.id),'[]'::jsonb));
 END IF;
 canonical:=jsonb_build_object('projectId',p_project_id,'expectedVersion',p_expected,'document',p_document);
 SELECT * INTO op FROM public.content_design_operations WHERE actor_id=p_actor AND sede_id=p_sede AND operation_key=p_operation_key;
 IF FOUND THEN
  IF op.canonical_payload IS DISTINCT FROM canonical OR op.project_id<>p_project_id THEN RAISE EXCEPTION 'CONTENT_DESIGN_IDEMPOTENCY_CONFLICT';END IF;
  RETURN jsonb_build_object('project',public.content_design_dto038(pr),'replayed',true,'receipt',jsonb_build_object('operationKey',p_operation_key,'projectId',pr.id,'savedVersion',op.version));
 END IF;
 IF pr.id IS NULL THEN
  IF p_expected<>0 THEN RAISE EXCEPTION 'CONTENT_DESIGN_VERSION_CONFLICT';END IF;
  INSERT INTO public.content_design_projects(id,sede_id,version,base_entry_id,base_source_version,base_file_id,document,created_by,updated_by) VALUES(p_project_id,p_sede,1,req_entry,req_version,base_file,p_document,p_actor,p_actor) RETURNING * INTO pr;
 ELSE
  IF pr.version<>p_expected THEN RAISE EXCEPTION 'CONTENT_DESIGN_VERSION_CONFLICT';END IF;
  UPDATE public.content_design_projects SET version=version+1,base_entry_id=req_entry,base_source_version=req_version,base_file_id=base_file,document=p_document,updated_by=p_actor,updated_at=now() WHERE id=pr.id RETURNING * INTO pr;
 END IF;
 INSERT INTO public.content_design_operations(project_id,version,actor_id,sede_id,operation_key,canonical_payload,snapshot) VALUES(pr.id,pr.version,p_actor,p_sede,p_operation_key,canonical,public.content_design_dto038(pr));
 RETURN jsonb_build_object('project',public.content_design_dto038(pr),'replayed',false,'receipt',jsonb_build_object('operationKey',p_operation_key,'projectId',pr.id,'savedVersion',pr.version));
END$$;
REVOKE ALL ON FUNCTION public.content_design_command038(uuid,bigint,text,uuid,bigint,jsonb,uuid),public.content_design_base038(bigint,uuid,bigint),public.content_design_dto038(public.content_design_projects),public.content_design_immutable038(),public.content_design_owner038() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.content_design_command038(uuid,bigint,text,uuid,bigint,jsonb,uuid) TO service_role;
COMMIT;
