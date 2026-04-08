/**
 * Publish to Cloud — Placeholder for cloud publishing feature
 * Matches TallyVision's "Publish to Cloud" sidebar item
 */
import { Cloud } from 'lucide-react';

export default function PublishCloudPage() {
  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-theme-heading mb-4">Publish to Cloud</h1>
      <div className="bg-dark-700 rounded-2xl border border-dark-400/20 p-12 text-center">
        <Cloud size={48} className="text-theme-faint mx-auto mb-4" />
        <h2 className="text-lg font-semibold text-theme-heading mb-2">Cloud Publishing</h2>
        <p className="text-theme-muted text-sm">
          Publish your financial reports and dashboards to the cloud for stakeholder access.
        </p>
        <p className="text-theme-faint text-xs mt-4">This feature is being configured for your account.</p>
      </div>
    </div>
  );
}
