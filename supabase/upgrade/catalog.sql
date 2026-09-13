-- One stable, data-free catalog contract. Keep snapshots private: routine and
-- default expressions can themselves contain accidentally embedded secrets.
-- The caller wraps this SELECT in READ ONLY or uses it inside the upgrade.
with
app_relations as (
  select c.*, n.nspname from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('r','p','v','m','S','f')
    and not exists (select 1 from pg_catalog.pg_depend d
      where d.classid='pg_catalog.pg_class'::regclass and d.objid=c.oid and d.deptype='e')
),
app_routines as (
  select p.*, n.nspname from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='public' and not exists (
    select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_proc'::regclass
      and d.objid=p.oid and d.deptype='e'))
    or (n.nspname='auth' and p.proname in ('uid','role','jwt'))
),
objects(key, value) as (
  select 'relation:'||r.nspname||'.'||r.relname,
    jsonb_build_object('kind',r.relkind,'owner',pg_get_userbyid(r.relowner),
      'rls',r.relrowsecurity,'force_rls',r.relforcerowsecurity,
      'options',r.reloptions,'persistence',r.relpersistence,
      'view',case when r.relkind in ('v','m') then pg_get_viewdef(r.oid,false) end,
      'partition',case when r.relkind='p' then pg_get_partkeydef(r.oid) end,
      'acl',coalesce((select jsonb_agg(jsonb_build_array(
        pg_get_userbyid(a.grantor),case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
        a.privilege_type,a.is_grantable) order by a.grantor::regrole::text,a.grantee::regrole::text,a.privilege_type)
        from aclexplode(coalesce(r.relacl,acldefault(case when r.relkind='S' then 'S'::"char" else 'r'::"char" end,r.relowner))) a),'[]'::jsonb))
  from app_relations r
  union all
  select 'column:'||r.nspname||'.'||r.relname||'.'||a.attname,
    jsonb_build_object('number',a.attnum,'type',format_type(a.atttypid,a.atttypmod),
      'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
      'default',pg_get_expr(d.adbin,d.adrelid,false),'storage',a.attstorage,
      'collation',case when a.attcollation<>0 then a.attcollation::regcollation::text end,
      'acl',coalesce((select jsonb_agg(jsonb_build_array(
        pg_get_userbyid(x.grantor),case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end,
        x.privilege_type,x.is_grantable) order by x.grantor::regrole::text,x.grantee::regrole::text,x.privilege_type)
        from aclexplode(a.attacl) x),'[]'::jsonb))
  from app_relations r join pg_attribute a on a.attrelid=r.oid
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where a.attnum>0 and not a.attisdropped
  union all
  select 'constraint:'||r.nspname||'.'||r.relname||'.'||c.conname,
    jsonb_build_object('definition',pg_get_constraintdef(c.oid,false),
      'validated',c.convalidated,'deferrable',c.condeferrable,'deferred',c.condeferred)
  from app_relations r join pg_constraint c on c.conrelid=r.oid
  union all
  select 'index:'||r.nspname||'.'||ic.relname,
    jsonb_build_object('definition',pg_get_indexdef(i.indexrelid),
      'valid',i.indisvalid,'ready',i.indisready,'replica_identity',i.indisreplident)
  from app_relations r join pg_index i on i.indrelid=r.oid
  join pg_class ic on ic.oid=i.indexrelid
  union all
  select 'sequence:'||r.nspname||'.'||r.relname,
    jsonb_build_object('type',format_type(s.seqtypid,null),'start',s.seqstart,
      'increment',s.seqincrement,'max',s.seqmax,'min',s.seqmin,'cache',s.seqcache,'cycle',s.seqcycle,
      'owned_by',(select jsonb_agg(n.nspname||'.'||c.relname||'.'||a.attname order by n.nspname,c.relname,a.attname)
        from pg_depend d join pg_class c on c.oid=d.refobjid
        join pg_namespace n on n.oid=c.relnamespace
        join pg_attribute a on a.attrelid=c.oid and a.attnum=d.refobjsubid
        where d.classid='pg_class'::regclass and d.objid=r.oid and d.deptype in ('a','i')))
  from app_relations r join pg_sequence s on s.seqrelid=r.oid
  union all
  select 'routine:'||r.nspname||'.'||r.proname||'('||pg_get_function_identity_arguments(r.oid)||')',
    jsonb_build_object('kind',r.prokind,'definition',case when r.prokind<>'a' then pg_get_functiondef(r.oid) else r.prosrc end,'owner',pg_get_userbyid(r.proowner),
      'security_definer',r.prosecdef,'leakproof',r.proleakproof,'config',r.proconfig,
      'acl',coalesce((select jsonb_agg(jsonb_build_array(
        pg_get_userbyid(a.grantor),case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
        a.privilege_type,a.is_grantable) order by a.grantor::regrole::text,a.grantee::regrole::text,a.privilege_type)
        from aclexplode(coalesce(r.proacl,acldefault('f',r.proowner))) a),'[]'::jsonb))
  from app_routines r
  union all
  select 'trigger:'||n.nspname||'.'||c.relname||'.'||t.tgname,
    jsonb_build_object('definition',pg_get_triggerdef(t.oid,false),'enabled',t.tgenabled)
  from pg_trigger t join pg_class c on c.oid=t.tgrelid
  join pg_namespace n on n.oid=c.relnamespace
  where not t.tgisinternal and (c.oid in (select oid from app_relations)
    or (n.nspname='auth' and c.relname='users' and t.tgname='on_auth_user_created'))
  union all
  select 'policy:'||n.nspname||'.'||c.relname||'.'||p.polname,
    jsonb_build_object('command',p.polcmd,'permissive',p.polpermissive,
      'using',pg_get_expr(p.polqual,p.polrelid,false),'check',pg_get_expr(p.polwithcheck,p.polrelid,false),
      'roles',(select jsonb_agg(case when x=0 then 'PUBLIC' else pg_get_userbyid(x) end order by x::regrole::text)
        from unnest(p.polroles) x))
  from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
  where c.oid in (select oid from app_relations) or (n.nspname='storage' and c.relname='objects')
  union all
  select 'rule:'||n.nspname||'.'||c.relname||'.'||r.rulename,
    jsonb_build_object('definition',pg_get_ruledef(r.oid,false),'enabled',r.ev_enabled)
  from pg_rewrite r join pg_class c on c.oid=r.ev_class join pg_namespace n on n.oid=c.relnamespace
  where c.oid in (select oid from app_relations) and r.rulename<>'_RETURN'
  union all
  select 'enum:'||n.nspname||'.'||t.typname,
    jsonb_build_object('owner',pg_get_userbyid(t.typowner),
      'values',(select jsonb_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid=t.oid))
  from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typtype='e'
  union all
  select 'type:'||n.nspname||'.'||t.typname,
    jsonb_build_object('kind',t.typtype,'owner',pg_get_userbyid(t.typowner),
      'base_type',format_type(t.typbasetype,t.typtypmod),'not_null',t.typnotnull,'default',t.typdefault,
      'acl',(select jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),
        case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,a.privilege_type,a.is_grantable)
        order by a.grantor::regrole::text,a.grantee::regrole::text,a.privilege_type)
        from aclexplode(coalesce(t.typacl,acldefault('T',t.typowner))) a),
      'constraints',(select jsonb_agg(pg_get_constraintdef(c.oid,false) order by c.conname)
        from pg_constraint c where c.contypid=t.oid))
  from pg_type t join pg_namespace n on n.oid=t.typnamespace
  where n.nspname='public' and t.typtype in ('d','e','r','m') and not exists (
    select 1 from pg_depend d where d.classid='pg_type'::regclass and d.objid=t.oid and d.deptype='e')
  union all
  select 'schema:'||n.nspname,
    jsonb_build_object('owner',pg_get_userbyid(n.nspowner),
      'acl',(select jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),
        case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,a.privilege_type,a.is_grantable)
        order by a.grantor::regrole::text,a.grantee::regrole::text,a.privilege_type)
        from aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a))
  from pg_namespace n where n.nspname in ('public','auth','storage','vault')
  union all
  select 'role:'||r.rolname,jsonb_build_object('superuser',r.rolsuper,'inherit',r.rolinherit,
    'create_role',r.rolcreaterole,'create_db',r.rolcreatedb,'login',r.rolcanlogin,
    'replication',r.rolreplication,'bypass_rls',r.rolbypassrls,'connection_limit',r.rolconnlimit,
    'valid_until',r.rolvaliduntil)
  from pg_roles r
  union all
  select 'membership:'||pg_get_userbyid(m.member)||'>'||pg_get_userbyid(m.roleid)||'/'||pg_get_userbyid(m.grantor),
    jsonb_build_object('admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option)
  from pg_auth_members m
  union all
  select 'default_acl:'||pg_get_userbyid(d.defaclrole)||'/'||coalesce(n.nspname,'*')||'/'||d.defaclobjtype::text,
    jsonb_build_object('acl',(select jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),
      case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,a.privilege_type,a.is_grantable)
      order by a.grantor::regrole::text,a.grantee::regrole::text,a.privilege_type)
      from aclexplode(d.defaclacl) a))
  from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
  union all
  select 'extension:'||e.extname,jsonb_build_object('version',e.extversion,
    'schema',n.nspname,'owner',pg_get_userbyid(e.extowner))
  from pg_extension e join pg_namespace n on n.oid=e.extnamespace
  union all
  select 'role_setting:'||coalesce(r.rolname,'*')||'/'||coalesce(d.datname,'*')||'/'||split_part(v,'=',1),
    jsonb_build_object('value_sha256',encode(sha256(convert_to(v,'UTF8')),'hex'))
  from pg_db_role_setting s left join pg_roles r on r.oid=s.setrole
  left join pg_database d on d.oid=s.setdatabase cross join unnest(s.setconfig) v
)
select jsonb_build_object('schema_version',1,
  'server',jsonb_build_object('database',current_database(),'role',current_user,
    'version_num',current_setting('server_version_num'),
    'vault_references',has_table_privilege(current_user,'vault.secrets','REFERENCES'),
    'public_create',has_schema_privilege(current_user,'public','CREATE'),
    'database_create',has_database_privilege(current_user,current_database(),'CREATE'),
    'storage_admin_member',case when exists(select 1 from pg_roles where rolname='supabase_storage_admin')
      then pg_has_role(current_user,'supabase_storage_admin','MEMBER') else false end),
  'objects',(select jsonb_object_agg(key,value order by key) from objects),
  'object_count',(select count(*) from objects),
  'unique_object_count',(select count(distinct key) from objects))
