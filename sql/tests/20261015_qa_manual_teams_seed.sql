INSERT INTO public.sedes VALUES(8),(9);
INSERT INTO public.torneos VALUES(555,8,true,'padbol','dobles','dobles',NULL,'abierto','knockout',0,0),(556,9,true,'padbol','dobles','dobles',NULL,'abierto','knockout',0,0),(557,8,false,'padbol','dobles','dobles',NULL,'abierto','knockout',0,0);
INSERT INTO auth.users VALUES('11111111-1111-4111-8111-111111111111','{}'),('99999999-9999-4999-8999-999999999999','{}'),('88888888-8888-4888-8888-888888888888','{}');
INSERT INTO public.user_roles VALUES('11111111-1111-4111-8111-111111111111','admin_club',8),('99999999-9999-4999-8999-999999999999','admin_club',9),('88888888-8888-4888-8888-888888888888','admin_club',NULL);
INSERT INTO auth.users SELECT ('22222222-2222-4222-8222-'||lpad(i::text,12,'0'))::uuid,jsonb_build_object('qa_test',true,'qa_torneo_id',555,'qa_sede_id',8) FROM generate_series(1,8) i;
INSERT INTO public.jugadores_perfil SELECT id,'QA Chivi '||right(id::text,2),'Prueba','1990-01-01'::date FROM auth.users WHERE id::text LIKE '22222222%';
