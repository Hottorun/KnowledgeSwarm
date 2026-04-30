create extension if not exists "pgcrypto";

create table if not exists public.research_runs (
  id uuid primary key default gen_random_uuid(),
  prompt text not null,
  status text not null default 'created'
    check (status in ('created', 'running', 'completed', 'failed', 'cancelled')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.graph_nodes (
  id text not null,
  run_id uuid not null references public.research_runs(id) on delete cascade,
  label text not null,
  type text not null default 'Entity',
  properties jsonb not null default '{}'::jsonb,
  created_by_agent text,
  created_at timestamptz not null default now(),
  primary key (run_id, id)
);

create table if not exists public.graph_edges (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.research_runs(id) on delete cascade,
  source_node_id text not null,
  target_node_id text not null,
  predicate text not null,
  confidence numeric(4, 3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  properties jsonb not null default '{}'::jsonb,
  created_by_agent text,
  created_at timestamptz not null default now(),
  foreign key (run_id, source_node_id) references public.graph_nodes(run_id, id) on delete cascade,
  foreign key (run_id, target_node_id) references public.graph_nodes(run_id, id) on delete cascade
);

create table if not exists public.sources (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.research_runs(id) on delete cascade,
  url text,
  title text,
  snippet text,
  source_type text not null default 'web',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.edge_sources (
  edge_id uuid not null references public.graph_edges(id) on delete cascade,
  source_id uuid not null references public.sources(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (edge_id, source_id)
);

create table if not exists public.agent_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.research_runs(id) on delete cascade,
  agent_name text not null,
  event_type text not null,
  message text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists research_runs_status_idx on public.research_runs(status);
create index if not exists graph_nodes_run_id_idx on public.graph_nodes(run_id);
create index if not exists graph_edges_run_id_idx on public.graph_edges(run_id);
create index if not exists graph_edges_source_target_idx on public.graph_edges(run_id, source_node_id, target_node_id);
create index if not exists sources_run_id_idx on public.sources(run_id);
create index if not exists agent_events_run_id_created_at_idx on public.agent_events(run_id, created_at);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_research_runs_updated_at on public.research_runs;
create trigger set_research_runs_updated_at
before update on public.research_runs
for each row execute function public.set_updated_at();

alter table public.research_runs replica identity full;
alter table public.graph_nodes replica identity full;
alter table public.graph_edges replica identity full;
alter table public.sources replica identity full;
alter table public.agent_events replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'research_runs'
    ) then
      alter publication supabase_realtime add table public.research_runs;
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'graph_nodes'
    ) then
      alter publication supabase_realtime add table public.graph_nodes;
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'graph_edges'
    ) then
      alter publication supabase_realtime add table public.graph_edges;
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'sources'
    ) then
      alter publication supabase_realtime add table public.sources;
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'agent_events'
    ) then
      alter publication supabase_realtime add table public.agent_events;
    end if;
  end if;
end $$;
