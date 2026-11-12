import React from 'react';

// Required on every page (PLAN.md hard rule). Never contacts any real emergency service.
export default function SafetyBanner() {
  return (
    <div className="safety-banner" role="note">
      Demo simulation — in a real emergency call <b>112</b>.
    </div>
  );
}
