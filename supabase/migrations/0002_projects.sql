-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Project documents (stores extracted text at upload time)
CREATE TABLE IF NOT EXISTS project_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT,
  raw_text TEXT NOT NULL,
  char_count INTEGER GENERATED ALWAYS AS (char_length(raw_text)) STORED,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Project maps (links a project to a generated research run)
CREATE TABLE IF NOT EXISTS project_maps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id UUID REFERENCES research_runs(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  prompt TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Triggers for updated_at
CREATE OR REPLACE TRIGGER set_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER set_project_maps_updated_at
  BEFORE UPDATE ON project_maps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Replica identity for realtime
ALTER TABLE projects REPLICA IDENTITY FULL;
ALTER TABLE project_documents REPLICA IDENTITY FULL;
ALTER TABLE project_maps REPLICA IDENTITY FULL;

-- Realtime (guard against publication not existing)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'projects'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.projects;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'project_documents'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.project_documents;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'project_maps'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.project_maps;
    END IF;
  END IF;
END $$;
