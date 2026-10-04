import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { PrOverviewBanner } from './PrOverviewBanner';

const SAMPLE = `# PR #123 — Fix the thing

## What / Why
- first point
- second point
`;

describe('PrOverviewBanner', () => {
  it('renders the overview markdown (heading + list)', () => {
    render(<PrOverviewBanner markdown={SAMPLE} />);
    expect(screen.getByText('PR #123 — Fix the thing')).toBeInTheDocument();
    expect(screen.getByText('first point')).toBeInTheDocument();
    expect(screen.getByText('second point')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /PR Overview/i })).toBeInTheDocument();
  });

  it('collapses and expands when the header is clicked', () => {
    render(<PrOverviewBanner markdown={SAMPLE} />);
    const toggle = screen.getByRole('button');

    fireEvent.click(toggle);
    // Body markdown is hidden; the derived title remains in the collapsed bar.
    expect(screen.queryByText('second point')).not.toBeInTheDocument();
    expect(screen.getByText('PR #123 — Fix the thing')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByText('second point')).toBeInTheDocument();
  });

  it('renders nothing for blank markdown', () => {
    const { container } = render(<PrOverviewBanner markdown="   " />);
    expect(container.firstChild).toBeNull();
  });

  it('ignores headings inside code fences when deriving the collapsed title', () => {
    const md = ['```bash', '# not a heading', 'echo hi', '```', '# Real Title', '', 'body'].join(
      '\n',
    );
    render(<PrOverviewBanner markdown={md} />);
    fireEvent.click(screen.getByRole('button')); // collapse → only the derived title shows
    expect(screen.getByText('Real Title')).toBeInTheDocument();
    expect(screen.queryByText('not a heading')).not.toBeInTheDocument();
  });
});
