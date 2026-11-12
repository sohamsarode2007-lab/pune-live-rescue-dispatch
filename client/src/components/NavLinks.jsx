import React from 'react';

const LINKS = [['/', 'Dispatcher'], ['/sos', 'SOS phone'], ['/algorithms', 'Algorithms']];

export default function NavLinks() {
  const here = window.location.pathname;
  return (
    <nav className="navlinks" aria-label="Pages">
      {LINKS.map(([href, label]) => (
        <a key={href} href={href} className={here === href ? 'on' : ''} aria-current={here === href ? 'page' : undefined}>{label}</a>
      ))}
    </nav>
  );
}
