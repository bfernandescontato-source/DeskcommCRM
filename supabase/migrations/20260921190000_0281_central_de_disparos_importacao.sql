-- Central de Disparos — IMPORTAÇÃO DE CONTATOS POR CSV (0281).
--
-- O problema. A importação de contatos que já existe recusa mais de 500 linhas e
-- decide tudo numa requisição só. Uma campanha tem 45 mil. A importação nova tem de:
--   - não travar a tela nem estourar tempo de requisição;
--   - mostrar ANTES de importar quantos são válidos, duplicados e inválidos;
--   - sobreviver a refresh, logout e reinício do servidor no meio;
--   - nunca duplicar contato nem colocar a mesma pessoa duas vezes na campanha.
--
-- O desenho: STAGING NO BANCO. O upload é lido e gravado, linha a linha, em
-- `campaign_import_rows` (status `raw`). A validação lê essas linhas em lotes,
-- aplica o mapeamento de colunas e grava o veredito de cada uma (`valid` ou
-- `rejected` + motivo). Só então o operador vê o resumo e confirma; a importação
-- em si promove as linhas `valid` para contatos + `campaign_contacts`, em lotes,
-- cada lote numa transação. Cada passo é idempotente e retomável: quem fechou a
-- aba volta e continua do ponto exato.
--
-- POR QUE NÃO NO NAVEGADOR. A regra de telefone brasileiro (DDI, nono dígito) mora
-- em código de servidor; validar dos dois lados seria duas regras que divergem, e
-- foi assim que a importação antiga já produziu número quebrado. Aqui há UMA regra.
--
-- DADO PESSOAL. As linhas cruas são a planilha do operador — nome, telefone, e-mail.
-- Ao importar, o que virou contato/campanha vive nas tabelas de sempre e o rastro na
-- staging perde os dados pessoais (`fn_campaign_import_commit`); as rejeitadas ficam
-- para o operador baixar e corrigir, e somem sozinhas em `fn_campaign_import_purge`.
-- A staging NÃO tem FK para `contacts` de propósito: é cópia transitória, não vínculo.
--
-- Nenhuma função aqui emite `contact.created`: importar 45 mil contatos não deve
-- acionar automação, IA ou notificação para cada um deles.

-- ═══ A. TABELAS ═══════════════════════════════════════════════════════════════

create table if not exists public.campaign_imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  campaign_id uuid not null,
  filename text not null check (char_length(filename) between 1 and 255),
  status text not null default 'uploaded'
    check (status in ('uploaded','validated','importing','done','cancelled')),
  headers jsonb not null default '[]'::jsonb check (jsonb_typeof(headers) = 'array'),
  mapping jsonb check (mapping is null or jsonb_typeof(mapping) = 'object'),
  total_rows integer not null default 0 check (total_rows >= 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  validated_at timestamptz,
  finished_at timestamptz,
  foreign key (campaign_id, organization_id)
    references public.campaigns (id, organization_id) on delete cascade
);
create index if not exists idx_campaign_imports_campaign
  on public.campaign_imports (campaign_id, created_at desc);

create table if not exists public.campaign_import_rows (
  import_id uuid not null references public.campaign_imports(id) on delete cascade,
  -- Linha de DADOS do arquivo, começando em 1 (o cabeçalho não conta). O operador
  -- soma 1 ao abrir na planilha; a tela já mostra o número que ele vê.
  line_no integer not null check (line_no >= 1),
  organization_id uuid not null,
  status text not null default 'raw' check (status in ('raw','valid','rejected','imported')),
  reason text check (reason is null or reason in (
    'empty_phone','invalid_phone','invalid_email','duplicate_in_file','already_in_campaign','bad_row')),
  -- A linha crua (array de textos). Some quando a linha é importada.
  cells jsonb check (cells is null or jsonb_typeof(cells) = 'array'),
  name text,
  phone text,
  phone_variants text[],
  email text,
  extras jsonb check (extras is null or jsonb_typeof(extras) = 'object'),
  -- Só para a prévia ("já são contatos" x "vão ser criados"). Sem FK de propósito.
  contact_id uuid,
  primary key (import_id, line_no),
  check ((status = 'rejected') = (reason is not null))
);
create index if not exists idx_campaign_import_rows_status
  on public.campaign_import_rows (import_id, status, line_no);

-- De qual importação e de qual linha veio cada contato da campanha: é o que torna
-- repetir um lote inofensivo e permite "de onde veio esta pessoa".
alter table public.campaign_contacts add column if not exists import_id uuid
  references public.campaign_imports(id) on delete set null;
alter table public.campaign_contacts add column if not exists import_line_no integer;
create unique index if not exists uniq_campaign_contacts_import_line
  on public.campaign_contacts (import_id, import_line_no) where import_id is not null;

-- ═══ B. RLS: SERVIDOR-ONLY ════════════════════════════════════════════════════
-- Nem leitura pelo navegador: são linhas cruas de planilha. A tela lê pela API.

do $f$
declare t text;
begin
  foreach t in array array['campaign_imports','campaign_import_rows'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_' || t || '_all', t);
    execute format(
      'create policy %I on public.%I for all using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()) with check (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin())',
      'tenant_isolation_' || t || '_all', t);
    execute format('revoke all on public.%I from anon, authenticated, public', t);
  end loop;
end $f$;

-- ═══ C. FUNÇÕES ═══════════════════════════════════════════════════════════════

-- C1. Abre uma importação para a campanha (não aceita campanha encerrada).
create or replace function public.fn_campaign_import_create(
  p_org uuid, p_campaign uuid, p_actor uuid, p_filename text, p_headers jsonb, p_total integer
) returns uuid language plpgsql security definer set search_path = public as $f$
declare v_status text; v_id uuid;
begin
  select status into v_status from public.campaigns
   where id = p_campaign and organization_id = p_org for share;
  if not found then raise exception 'campaign_not_found' using errcode = 'P0002'; end if;
  if v_status in ('completed','cancelled') then
    raise exception 'campaign_closed' using errcode = 'P0001';
  end if;
  insert into public.campaign_imports (organization_id, campaign_id, filename, headers, total_rows, created_by)
  values (p_org, p_campaign, btrim(p_filename), coalesce(p_headers, '[]'::jsonb), greatest(coalesce(p_total, 0), 0), p_actor)
  returning id into v_id;
  return v_id;
end $f$;

-- C2. Grava linhas cruas em lote. Idempotente: repetir o lote não duplica.
create or replace function public.fn_campaign_import_stage_raw(
  p_org uuid, p_import uuid, p_rows jsonb
) returns integer language plpgsql security definer set search_path = public as $f$
declare v_status text; v_n integer;
begin
  select status into v_status from public.campaign_imports
   where id = p_import and organization_id = p_org for share;
  if not found then raise exception 'campaign_import_not_found' using errcode = 'P0002'; end if;
  if v_status <> 'uploaded' then raise exception 'campaign_import_locked' using errcode = 'P0001'; end if;
  insert into public.campaign_import_rows (import_id, organization_id, line_no, cells)
  select p_import, p_org, r.n, r.cells
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(n integer, cells jsonb)
  on conflict (import_id, line_no) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $f$;

-- C3. Grava o veredito da validação (feito no servidor, com a regra de telefone da
-- casa). Pode ser repetido com outro mapeamento enquanto nada foi importado.
create or replace function public.fn_campaign_import_apply(
  p_org uuid, p_import uuid, p_results jsonb
) returns integer language plpgsql security definer set search_path = public as $f$
declare v_status text; v_n integer;
begin
  select status into v_status from public.campaign_imports
   where id = p_import and organization_id = p_org for share;
  if not found then raise exception 'campaign_import_not_found' using errcode = 'P0002'; end if;
  if v_status not in ('uploaded','validated') then
    raise exception 'campaign_import_locked' using errcode = 'P0001';
  end if;
  with r as (
    select * from jsonb_to_recordset(coalesce(p_results, '[]'::jsonb))
      as x(n integer, status text, reason text, name text, phone text, variants jsonb, email text, extras jsonb))
  update public.campaign_import_rows w
     set status = r.status, reason = r.reason, name = r.name, phone = r.phone,
         phone_variants = case when r.variants is null then null
                               else array(select jsonb_array_elements_text(r.variants)) end,
         email = r.email, extras = r.extras, contact_id = null
    from r
   where w.import_id = p_import and w.line_no = r.n and w.status <> 'imported';
  get diagnostics v_n = row_count;
  return v_n;
end $f$;

-- C4. Resumo, direto da fonte (as linhas), nunca de contador.
create or replace function public.fn_campaign_import_summary(p_org uuid, p_import uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $f$
declare i public.campaign_imports%rowtype; v jsonb;
begin
  select * into i from public.campaign_imports where id = p_import and organization_id = p_org;
  if not found then raise exception 'campaign_import_not_found' using errcode = 'P0002'; end if;
  select jsonb_build_object(
    'found', count(*),
    'raw', count(*) filter (where status = 'raw'),
    'valid', count(*) filter (where status = 'valid'),
    'imported', count(*) filter (where status = 'imported'),
    'rejected', count(*) filter (where status = 'rejected'),
    'existing_contacts', count(*) filter (where status = 'valid' and contact_id is not null),
    'new_contacts', count(*) filter (where status = 'valid' and contact_id is null))
    into v from public.campaign_import_rows where import_id = p_import;
  return v || jsonb_build_object(
    'import_id', i.id, 'campaign_id', i.campaign_id, 'status', i.status, 'filename', i.filename,
    'total_rows', i.total_rows, 'headers', i.headers, 'mapping', i.mapping,
    'by_reason', coalesce((
      select jsonb_object_agg(reason, n)
        from (select reason, count(*) as n from public.campaign_import_rows
               where import_id = p_import and status = 'rejected' group by reason) g), '{}'::jsonb));
end $f$;

-- C5. Fecha a validação: acha os duplicados que só o conjunto enxerga (repetidos no
-- arquivo, o mesmo contato por dois números equivalentes, quem já está na campanha) e
-- casa cada linha válida com o contato que já existe. Depois disso o resumo é o que
-- vai acontecer se o operador confirmar.
create or replace function public.fn_campaign_import_finish_validation(
  p_org uuid, p_import uuid, p_mapping jsonb
) returns jsonb language plpgsql security definer set search_path = public as $f$
declare i public.campaign_imports%rowtype;
begin
  select * into i from public.campaign_imports
   where id = p_import and organization_id = p_org for update;
  if not found then raise exception 'campaign_import_not_found' using errcode = 'P0002'; end if;
  if i.status not in ('uploaded','validated') then
    raise exception 'campaign_import_locked' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.campaign_import_rows where import_id = p_import and status = 'raw') then
    raise exception 'campaign_import_not_validated' using errcode = 'P0001';
  end if;

  -- 1) o contato que já existe (o mesmo número, com ou sem o nono dígito)
  update public.campaign_import_rows w
     set contact_id = (
       select c.id from public.contacts c
        where c.organization_id = p_org and c.is_merged_into is null
          and c.phone_number = any (w.phone_variants)
        order by (c.phone_number = w.phone) desc, c.created_at
        limit 1)
   where w.import_id = p_import and w.status = 'valid';

  -- 2) o mesmo telefone repetido no arquivo: fica a primeira ocorrência
  with d as (
    select line_no, row_number() over (partition by phone order by line_no) as k
      from public.campaign_import_rows where import_id = p_import and status = 'valid')
  update public.campaign_import_rows w
     set status = 'rejected', reason = 'duplicate_in_file'
    from d where w.import_id = p_import and w.line_no = d.line_no and d.k > 1;

  -- 3) dois números equivalentes que resolvem para o MESMO contato
  with d as (
    select line_no, row_number() over (partition by contact_id order by line_no) as k
      from public.campaign_import_rows
     where import_id = p_import and status = 'valid' and contact_id is not null)
  update public.campaign_import_rows w
     set status = 'rejected', reason = 'duplicate_in_file'
    from d where w.import_id = p_import and w.line_no = d.line_no and d.k > 1;

  -- 4) quem já está nesta campanha
  update public.campaign_import_rows w
     set status = 'rejected', reason = 'already_in_campaign'
   where w.import_id = p_import and w.status = 'valid' and w.contact_id is not null
     and exists (select 1 from public.campaign_contacts cc
                  where cc.campaign_id = i.campaign_id and cc.contact_id = w.contact_id);

  update public.campaign_imports
     set mapping = p_mapping, status = 'validated', validated_at = now(), updated_at = now()
   where id = p_import;
  return public.fn_campaign_import_summary(p_org, p_import);
end $f$;

-- C6. Importa um lote das linhas válidas. Cada chamada é uma transação; repetir é
-- inofensivo (a linha importada sai de `valid`). O contato é casado DE NOVO aqui
-- (alguém pode ter criado o mesmo número depois da validação) e o e-mail que já é de
-- outro contato — ou que se repete no lote — é dispensado em vez de derrubar o lote
-- inteiro pelo índice único de e-mail.
create or replace function public.fn_campaign_import_commit(
  p_org uuid, p_import uuid, p_actor uuid default null, p_limit integer default 2000
) returns jsonb language plpgsql security definer set search_path = public as $f$
declare
  i public.campaign_imports%rowtype; v_cstatus text;
  v_limit integer := greatest(1, least(coalesce(p_limit, 2000), 5000));
  v_processed integer := 0; v_remaining integer; v_summary jsonb;
begin
  select campaign_id into i.campaign_id from public.campaign_imports
   where id = p_import and organization_id = p_org;
  if not found then raise exception 'campaign_import_not_found' using errcode = 'P0002'; end if;

  -- Ordem de locks: campanha (share) -> importação, a mesma das demais funções.
  select status into v_cstatus from public.campaigns where id = i.campaign_id for share;
  select * into i from public.campaign_imports where id = p_import for update;

  if i.status = 'done' then
    return jsonb_build_object('processed', 0, 'remaining', 0, 'status', 'done');
  end if;
  if i.status not in ('validated','importing') then
    raise exception 'campaign_import_not_validated' using errcode = 'P0001';
  end if;
  if v_cstatus in ('completed','cancelled') then
    raise exception 'campaign_closed' using errcode = 'P0001';
  end if;
  if i.status = 'validated' then
    update public.campaign_imports set status = 'importing', updated_at = now() where id = p_import;
  end if;

  with chunk as (
    select w.line_no, w.name, w.phone, w.phone_variants, w.email, w.extras
      from public.campaign_import_rows w
     where w.import_id = p_import and w.status = 'valid'
     order by w.line_no limit v_limit for update
  ), matched as (
    select ch.*,
           (select c.id from public.contacts c
             where c.organization_id = p_org and c.is_merged_into is null
               and c.phone_number = any (ch.phone_variants)
             order by (c.phone_number = ch.phone) desc, c.created_at limit 1) as cid,
           row_number() over (partition by lower(btrim(ch.email)) order by ch.line_no) as email_k
      from chunk ch
  ), novos as (
    insert into public.contacts
      (organization_id, name, display_name, email, phone_number, source, source_metadata, consent, created_by_user_id)
    select p_org, m.name, m.name,
           case when m.email is null or m.email_k > 1
                  or exists (select 1 from public.contacts x
                              where x.organization_id = p_org and x.is_merged_into is null
                                and x.email_normalized = lower(btrim(m.email)))
                then null else m.email end,
           m.phone, 'campaign_import',
           jsonb_build_object('campaign_id', i.campaign_id, 'import_id', p_import),
           '{}'::jsonb, p_actor
      from matched m where m.cid is null
    returning id, phone_number
  ), resolved as (
    select m.line_no, m.extras, coalesce(m.cid, n.id) as cid
      from matched m left join novos n on m.cid is null and n.phone_number = m.phone
  ), colocados as (
    insert into public.campaign_contacts
      (organization_id, campaign_id, contact_id, import_id, import_line_no, variables)
    select p_org, i.campaign_id, r.cid, p_import, r.line_no, coalesce(r.extras, '{}'::jsonb)
      from resolved r where r.cid is not null
    on conflict (campaign_id, contact_id) do nothing
    returning import_line_no
  ), atualizadas as (
    update public.campaign_import_rows w
       set status = case when c.import_line_no is not null then 'imported' else 'rejected' end,
           reason = case when c.import_line_no is not null then null else 'already_in_campaign' end,
           contact_id = r.cid,
           cells = case when c.import_line_no is not null then null else w.cells end,
           name = case when c.import_line_no is not null then null else w.name end,
           phone = case when c.import_line_no is not null then null else w.phone end,
           phone_variants = null,
           email = case when c.import_line_no is not null then null else w.email end,
           extras = case when c.import_line_no is not null then null else w.extras end
      from resolved r left join colocados c on c.import_line_no = r.line_no
     where w.import_id = p_import and w.line_no = r.line_no
    returning w.line_no)
  select count(*) into v_processed from atualizadas;

  select count(*) into v_remaining from public.campaign_import_rows
   where import_id = p_import and status = 'valid';

  if v_remaining = 0 then
    update public.campaign_imports
       set status = 'done', finished_at = now(), updated_at = now() where id = p_import;
    v_summary := public.fn_campaign_import_summary(p_org, p_import);
    perform public.fn_campaign_log(p_org, i.campaign_id, 'imported', p_actor, null, null, null, null,
      jsonb_build_object('import_id', p_import, 'filename', i.filename,
                         'imported', v_summary -> 'imported', 'rejected', v_summary -> 'rejected',
                         'by_reason', v_summary -> 'by_reason'),
      'imported:' || p_import);
  else
    update public.campaign_imports set updated_at = now() where id = p_import;
  end if;

  return jsonb_build_object('processed', v_processed, 'remaining', v_remaining,
                            'status', case when v_remaining = 0 then 'done' else 'importing' end);
end $f$;

-- C7. Desiste: some com o que ainda não virou contato (dado pessoal cru). O que já foi
-- importado fica, e a importação segue no histórico.
create or replace function public.fn_campaign_import_cancel(p_org uuid, p_import uuid)
returns jsonb language plpgsql security definer set search_path = public as $f$
declare v_status text; v_deleted integer;
begin
  select status into v_status from public.campaign_imports
   where id = p_import and organization_id = p_org for update;
  if not found then raise exception 'campaign_import_not_found' using errcode = 'P0002'; end if;
  if v_status in ('done','cancelled') then
    return jsonb_build_object('changed', false, 'status', v_status);
  end if;
  delete from public.campaign_import_rows where import_id = p_import and status <> 'imported';
  get diagnostics v_deleted = row_count;
  update public.campaign_imports set status = 'cancelled', finished_at = now(), updated_at = now()
   where id = p_import;
  return jsonb_build_object('changed', true, 'status', 'cancelled', 'discarded_rows', v_deleted);
end $f$;

-- C8. Faxina: linha crua de importação abandonada ou terminada há mais de `p_days` dias
-- é dado pessoal sem finalidade — apaga. Importação abandonada (nunca confirmada) é
-- cancelada E tem as linhas cruas apagadas no mesmo passo; a terminada/cancelada
-- perde o resto (rejeitadas e rastros) depois do prazo. Chamada pelo cron de
-- manutenção das campanhas.
create or replace function public.fn_campaign_import_purge(p_days integer default 30)
returns jsonb language plpgsql security definer set search_path = public as $f$
declare
  v_corte timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 30), 1));
  v_abandoned integer; v_rows integer; v_n integer;
begin
  with ab as (
    update public.campaign_imports
       set status = 'cancelled', finished_at = now(), updated_at = now()
     where status in ('uploaded','validated','importing') and updated_at < v_corte
    returning id),
  del as (
    delete from public.campaign_import_rows w using ab
     where w.import_id = ab.id and w.status <> 'imported'
    returning 1)
  select (select count(*) from ab), (select count(*) from del) into v_abandoned, v_rows;

  delete from public.campaign_import_rows w
   using public.campaign_imports i
   where w.import_id = i.id and i.status in ('done','cancelled')
     and coalesce(i.finished_at, i.updated_at) < v_corte;
  get diagnostics v_n = row_count;
  return jsonb_build_object('abandoned_imports', v_abandoned, 'deleted_rows', v_rows + v_n);
end $f$;

-- ═══ D. EXECUTE: SÓ O SERVIDOR ════════════════════════════════════════════════
do $f$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in (
         'fn_campaign_import_create','fn_campaign_import_stage_raw','fn_campaign_import_apply',
         'fn_campaign_import_summary','fn_campaign_import_finish_validation',
         'fn_campaign_import_commit','fn_campaign_import_cancel','fn_campaign_import_purge')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $f$;

comment on table public.campaign_imports is 'Uma importação de CSV para uma campanha: upload, validação com prévia e importação em lotes. Retomável.';
comment on table public.campaign_import_rows is 'Staging das linhas do CSV. Linha importada perde os dados pessoais; rejeitadas ficam para o operador baixar e somem na faxina.';

do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;
