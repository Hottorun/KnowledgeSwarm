import type { DecompositionResult, Triple, SearchResult } from '../types';

export const STUB_DOCUMENT_TEXT = `
SERVICE AGREEMENT

This Service Agreement ("Agreement") is entered into as of January 1, 2025 ("Effective Date")
by and between Acme Corporation ("Service Provider"), a Delaware corporation with its principal
place of business at 123 Main Street, San Francisco, CA 94105, and Beta Industries ("Client"),
a New York corporation.

1. SERVICES
Service Provider agrees to provide cloud infrastructure management services as described in
Exhibit A. Services include 99.9% uptime SLA, 24/7 monitoring, and quarterly security audits.

2. COMPENSATION
Client shall pay Service Provider a monthly fee of $50,000 USD. Payment is due within 30 days
of invoice. Late payments incur a 1.5% monthly interest charge.

3. TERM
This Agreement commences on the Effective Date and continues for 24 months. Either party may
terminate with 90 days written notice.

4. INTELLECTUAL PROPERTY
All work product created by Service Provider under this Agreement shall be owned by Client.
Service Provider retains rights to its pre-existing intellectual property and tools.

5. CONFIDENTIALITY
Both parties agree to maintain strict confidentiality of all proprietary information shared
during the term of this Agreement and for 5 years thereafter.
`;

export const STUB_DECOMPOSITION: DecompositionResult = {
  documentType: 'contract',
  branches: [
    {
      id: 'parties',
      label: 'Parties & Roles',
      focus: 'Companies, persons, and their roles in the agreement',
      nodeTypes: ['Company', 'Person', 'Role', 'Location'],
    },
    {
      id: 'obligations',
      label: 'Obligations & Services',
      focus: 'What each party must do and deliver',
      nodeTypes: ['Obligation', 'Service', 'Date', 'Role'],
    },
    {
      id: 'financial',
      label: 'Financial Terms',
      focus: 'Payment amounts, schedules, and penalties',
      nodeTypes: ['Financial', 'Obligation', 'Date', 'Company'],
    },
  ],
};

export const STUB_SEARCH_RESULTS: SearchResult[] = [
  {
    title: 'Acme Corporation — Company Overview',
    url: 'https://example.com/acme-overview',
    snippet: 'Acme Corporation is a leading cloud infrastructure provider founded in 2010, headquartered in San Francisco. It serves over 500 enterprise clients globally.',
    score: 0.92,
  },
  {
    title: 'Beta Industries Q3 2024 Report',
    url: 'https://example.com/beta-q3',
    snippet: 'Beta Industries reported $420M in annual revenue for 2024. The company has been expanding its technology outsourcing budget by 30% year-over-year.',
    score: 0.87,
  },
];

export const STUB_TRIPLES: Triple[] = [
  {
    subject: { id: 'company:acme-corporation', label: 'Acme Corporation', type: 'Company', properties: { location: 'San Francisco, CA', state: 'Delaware' } },
    predicate: 'provides_services_to',
    object: { id: 'company:beta-industries', label: 'Beta Industries', type: 'Company', properties: { state: 'New York' } },
    confidence: 0.98,
    sources: [{ url: 'document', title: 'Service Agreement', snippet: 'Acme Corporation ("Service Provider") and Beta Industries ("Client")' }],
    properties: { agreementDate: '2025-01-01' },
  },
  {
    subject: { id: 'company:beta-industries', label: 'Beta Industries', type: 'Company', properties: {} },
    predicate: 'pays_monthly_fee',
    object: { id: 'financial:monthly-fee-50k', label: '$50,000 Monthly Fee', type: 'Financial', properties: { amount: 50000, currency: 'USD', periodDays: 30 } },
    confidence: 0.97,
    sources: [{ url: 'document', title: 'Service Agreement §2', snippet: 'Client shall pay Service Provider a monthly fee of $50,000 USD' }],
    properties: {},
  },
  {
    subject: { id: 'company:acme-corporation', label: 'Acme Corporation', type: 'Company', properties: {} },
    predicate: 'must_provide',
    object: { id: 'obligation:uptime-sla', label: '99.9% Uptime SLA', type: 'Obligation', properties: { percentage: 99.9 } },
    confidence: 0.96,
    sources: [{ url: 'document', title: 'Service Agreement §1', snippet: 'Services include 99.9% uptime SLA' }],
    properties: {},
  },
];
