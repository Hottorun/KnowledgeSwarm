export interface KGNode {
  id: string;
  label: string;
  description?: string;
  type: 'root' | 'topic' | 'subtopic' | 'detail';
  children?: string[];
}

export interface KGEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface AIReasoningStep {
  id: string;
  text: string;
  timestamp: Date;
  type: 'analysis' | 'connection' | 'expansion';
}

export interface DataSource {
  id: string;
  name: string;
  type: 'file' | 'text';
  addedAt: Date;
}