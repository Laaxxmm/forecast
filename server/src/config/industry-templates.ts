export interface StreamTemplate {
  name: string;
  icon: string;
  color: string;
}

export interface IndustryTemplate {
  key: string;
  label: string;
  description: string;
  streams: StreamTemplate[];
}

export const INDUSTRY_TEMPLATES: IndustryTemplate[] = [
  {
    key: 'healthcare',
    label: 'Healthcare',
    description: 'Hospitals, clinics, pharmacies, diagnostics',
    streams: [
      { name: 'Clinic', icon: 'Stethoscope', color: 'blue' },
      { name: 'Pharmacy', icon: 'Pill', color: 'purple' },
      { name: 'Lab / Diagnostics', icon: 'FlaskConical', color: 'amber' },
    ],
  },
  {
    key: 'restaurant',
    label: 'Restaurant / F&B',
    description: 'Restaurants, cafes, cloud kitchens, catering',
    streams: [
      { name: 'Dine-in', icon: 'UtensilsCrossed', color: 'blue' },
      { name: 'Delivery', icon: 'Truck', color: 'purple' },
      { name: 'Catering', icon: 'ChefHat', color: 'amber' },
      { name: 'Takeaway', icon: 'ShoppingBag', color: 'accent' },
    ],
  },
  {
    key: 'consultancy',
    label: 'Consultancy / Services',
    description: 'Consulting firms, agencies, professional services',
    streams: [
      { name: 'Consulting', icon: 'Briefcase', color: 'blue' },
      { name: 'Subscriptions', icon: 'RefreshCcw', color: 'purple' },
      { name: 'Training', icon: 'GraduationCap', color: 'amber' },
    ],
  },
  {
    key: 'retail',
    label: 'Retail / E-commerce',
    description: 'Physical stores, online shops, wholesale',
    streams: [
      { name: 'In-store', icon: 'Store', color: 'blue' },
      { name: 'Online', icon: 'Globe', color: 'purple' },
      { name: 'Wholesale', icon: 'Warehouse', color: 'amber' },
    ],
  },
  {
    key: 'custom',
    label: 'Custom',
    description: 'Define your own revenue streams',
    streams: [],
  },
];
