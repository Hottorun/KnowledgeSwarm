import type { BranchPlan } from '../types';

export type SpecialistKind =
  | 'finance'
  | 'legal'
  | 'technical'
  | 'market'
  | 'people'
  | 'risk'
  | 'general';

export interface SpecialistProfile {
  kind: SpecialistKind;
  agentName: string;
  nodeTypes: string[];
  extractionHint: string;
  preferredPredicates: string[];
}

const SPECIALISTS: Record<SpecialistKind, SpecialistProfile> = {
  finance: {
    kind: 'finance',
    agentName: 'FinanceAgent',
    nodeTypes: ['Company', 'Financial', 'Investor', 'Market', 'Risk', 'Date'],
    extractionHint: 'Extract monetary values, payment terms, revenue, funding, valuation, investors, acquisitions, market size, financial exposure, and dated financial facts.',
    preferredPredicates: ['raised', 'invested_in', 'acquired', 'reported_revenue', 'valued_at', 'pays', 'faces_financial_risk', 'competes_in'],
  },
  legal: {
    kind: 'legal',
    agentName: 'LegalAgent',
    nodeTypes: ['Company', 'Contract', 'Obligation', 'Regulation', 'Jurisdiction', 'Date', 'Risk'],
    extractionHint: 'Extract contracts, parties, obligations, jurisdictions, legal restrictions, compliance requirements, licensing, confidentiality, termination terms, and legal risks.',
    preferredPredicates: ['party_to', 'has_obligation', 'governed_by', 'requires_compliance_with', 'licensed_to', 'may_terminate', 'faces_legal_risk'],
  },
  technical: {
    kind: 'technical',
    agentName: 'TechnicalAgent',
    nodeTypes: ['Company', 'Product', 'Technology', 'System', 'API', 'Database', 'Risk'],
    extractionHint: 'Extract systems, products, APIs, databases, integrations, technical dependencies, security controls, vulnerabilities, and implementation details.',
    preferredPredicates: ['uses', 'integrates_with', 'depends_on', 'stores_data_in', 'exposes_api', 'implements', 'has_vulnerability'],
  },
  market: {
    kind: 'market',
    agentName: 'MarketAgent',
    nodeTypes: ['Company', 'Market', 'Product', 'Customer', 'Competitor', 'Geography', 'Trend'],
    extractionHint: 'Extract markets, competitors, customers, industries, partnerships, geographies, commercial positioning, and trend relationships.',
    preferredPredicates: ['competes_with', 'serves_market', 'operates_in', 'partners_with', 'targets_customer', 'affected_by_trend'],
  },
  people: {
    kind: 'people',
    agentName: 'PeopleOrgAgent',
    nodeTypes: ['Person', 'Role', 'Team', 'Company', 'Department', 'Responsibility'],
    extractionHint: 'Extract people, roles, teams, reporting lines, ownership, responsibilities, advisors, and organizational relationships.',
    preferredPredicates: ['leads', 'reports_to', 'owns', 'member_of', 'responsible_for', 'advises'],
  },
  risk: {
    kind: 'risk',
    agentName: 'RiskAgent',
    nodeTypes: ['Company', 'Risk', 'Regulation', 'Dependency', 'Vendor', 'Technology', 'Market'],
    extractionHint: 'Extract regulatory, operational, vendor, financial, legal, technical, market, and dependency risks with their causes and affected entities.',
    preferredPredicates: ['faces_risk', 'caused_by', 'depends_on', 'exposed_to', 'mitigated_by', 'affected_by'],
  },
  general: {
    kind: 'general',
    agentName: 'GeneralAgent',
    nodeTypes: ['Entity', 'Company', 'Person', 'Product', 'Event', 'Date'],
    extractionHint: 'Extract the most important explicit facts and relationships that do not fit a narrower specialist.',
    preferredPredicates: ['related_to', 'provides', 'owns', 'uses', 'located_in', 'announced', 'depends_on'],
  },
};

const KEYWORDS: Array<[SpecialistKind, string[]]> = [
  ['finance', ['financial', 'finance', 'payment', 'revenue', 'funding', 'valuation', 'investor', 'acquisition', 'cost', 'fee', 'market size']],
  ['legal', ['legal', 'contract', 'agreement', 'obligation', 'compliance', 'regulation', 'jurisdiction', 'license', 'confidentiality', 'termination']],
  ['technical', ['technical', 'technology', 'system', 'api', 'database', 'security', 'integration', 'architecture', 'infrastructure', 'software']],
  ['market', ['market', 'customer', 'competitor', 'industry', 'partnership', 'geography', 'trend', 'commercial', 'sales']],
  ['people', ['people', 'person', 'role', 'team', 'leadership', 'employee', 'reports', 'responsibility', 'organization']],
  ['risk', ['risk', 'exposure', 'threat', 'dependency', 'vendor', 'liability', 'challenge', 'constraint', 'failure']],
];

const NODE_TYPE_HINTS: Array<[SpecialistKind, string[]]> = [
  ['finance', ['Financial', 'Investor', 'Revenue', 'Payment', 'Valuation']],
  ['legal', ['Contract', 'Obligation', 'Regulation', 'Jurisdiction', 'License']],
  ['technical', ['Technology', 'System', 'API', 'Database', 'Infrastructure', 'Security']],
  ['market', ['Market', 'Customer', 'Competitor', 'Product', 'Geography', 'Trend']],
  ['people', ['Person', 'Role', 'Team', 'Department', 'Responsibility']],
  ['risk', ['Risk', 'Dependency', 'Vendor', 'Threat']],
];

export function specialistForBranch(branch: BranchPlan): SpecialistProfile {
  const nodeTypes = new Set(branch.nodeTypes.map(t => t.toLowerCase()));
  for (const [kind, hints] of NODE_TYPE_HINTS) {
    if (hints.some(hint => nodeTypes.has(hint.toLowerCase()))) {
      return SPECIALISTS[kind];
    }
  }

  const text = `${branch.id} ${branch.label} ${branch.focus}`.toLowerCase();
  for (const [kind, keywords] of KEYWORDS) {
    if (keywords.some(keyword => text.includes(keyword))) {
      return SPECIALISTS[kind];
    }
  }

  return SPECIALISTS.general;
}

export function specialistDisplayName(specialist: SpecialistProfile, branch: BranchPlan): string {
  return `${specialist.agentName}:${branch.label}`;
}
