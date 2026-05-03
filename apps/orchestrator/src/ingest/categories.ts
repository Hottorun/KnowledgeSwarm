// Shared category enum used by the document classifier (apps/orchestrator/src/agents/classifier.ts)
// and the presentation builder (apps/orchestrator/src/ingest/presentation.ts). Keeping this in
// one place avoids drift between the two — they must agree on the set of valid categories.

export const CATEGORY_KEYS = [
  'finance',
  'hr-people',
  'legal',
  'operations',
  'strategy-market',
  'technology',
  'risk',
  'other',
] as const;

export type CategoryKey = typeof CATEGORY_KEYS[number];

export interface CategoryDef {
  key: CategoryKey;
  label: string;
  keywords: string[];
}

export const CATEGORIES: CategoryDef[] = [
  {
    key: 'finance',
    label: 'Finance',
    keywords: ['finance', 'financial', 'revenue', 'cost', 'margin', 'valuation', 'investor', 'funding', 'payment', 'fee', 'debt', 'profit', 'budget', 'acquisition'],
  },
  {
    key: 'hr-people',
    label: 'HR & People',
    keywords: ['people', 'person', 'employee', 'team', 'role', 'hr', 'salary', 'compensation', 'manager', 'reports', 'leadership', 'responsibility'],
  },
  {
    key: 'legal',
    label: 'Legal',
    keywords: ['legal', 'contract', 'agreement', 'patent', 'license', 'compliance', 'regulation', 'jurisdiction', 'obligation', 'confidentiality', 'termination'],
  },
  {
    key: 'operations',
    label: 'Operations',
    keywords: ['operation', 'warehouse', 'order', 'shipment', 'logistics', 'inventory', 'supplier', 'supply', 'facility', 'manufacturing', 'delivery', 'vendor'],
  },
  {
    key: 'strategy-market',
    label: 'Strategy & Market',
    keywords: ['market', 'customer', 'competitor', 'partner', 'partnership', 'industry', 'geography', 'growth', 'positioning', 'commercial', 'sales'],
  },
  {
    key: 'technology',
    label: 'Technology',
    keywords: ['technology', 'technical', 'system', 'software', 'api', 'database', 'security', 'product', 'platform', 'integration', 'infrastructure'],
  },
  {
    key: 'risk',
    label: 'Risk',
    keywords: ['risk', 'exposure', 'threat', 'dependency', 'liability', 'constraint', 'failure', 'mitigation', 'vulnerability'],
  },
];
