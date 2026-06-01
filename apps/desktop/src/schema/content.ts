export type TextListItem = {
  id: string;
  label: string;
};

export type BrandContent = {
  eyebrow: string;
  title: string;
  copy: string;
};

export type PageIntroContent = {
  eyebrow: string;
  title: string;
  copy: string;
};

export type NavItem = {
  id: string;
  label: string;
  hint: string;
  path: string;
};

export type StatItem = {
  id: string;
  label: string;
  value: string;
  hint: string;
};

export type Preset = {
  id: string;
  name: string;
  description: string;
  chips: TextListItem[];
};

export type ProviderCard = {
  id: string;
  name: string;
  protocol: string;
  notes: string;
};

export type InfoCardContent = {
  id: string;
  eyebrow: string;
  title: string;
  description?: string;
  items?: TextListItem[];
};

export type QuickSetupReadinessStatus = 'complete' | 'pending' | 'risk';

export type QuickSetupReadinessItem = {
  id: string;
  title: string;
  status: QuickSetupReadinessStatus;
  description: string;
  route: string;
};