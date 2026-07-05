import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { PaginationBar, pageWindow } from '../../../src/components/ui/pagination-bar.js';

afterEach(cleanup);

describe('pageWindow', () => {
  it('shows all pages when few', () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
  });
  it('collapses the middle with gaps', () => {
    expect(pageWindow(5, 23)).toEqual([1, 'gap', 4, 5, 6, 'gap', 23]);
  });
  it('handles first and last page without leading/trailing gaps', () => {
    expect(pageWindow(1, 23)).toEqual([1, 2, 'gap', 23]);
    expect(pageWindow(23, 23)).toEqual([1, 'gap', 22, 23]);
  });
});

describe('PaginationBar', () => {
  it('hides itself when everything fits on one page', () => {
    const { container } = render(
      <PaginationBar page={1} pageSize={25} total={10} onPageChange={() => undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the range summary and fires onPageChange', () => {
    const onPageChange = vi.fn();
    render(<PaginationBar page={3} pageSize={25} total={563} onPageChange={onPageChange} />);
    expect(screen.getByText('Showing 51–75 of 563')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(onPageChange).toHaveBeenCalledWith(4);
    fireEvent.click(screen.getByRole('button', { name: /prev/i }));
    expect(onPageChange).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole('button', { name: '1' }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('disables Prev on page 1 and Next on the last page', () => {
    render(<PaginationBar page={1} pageSize={25} total={30} onPageChange={() => undefined} />);
    expect(screen.getByRole('button', { name: /prev/i })).toBeDisabled();
    render(<PaginationBar page={2} pageSize={25} total={30} onPageChange={() => undefined} />);
    expect(screen.getAllByRole('button', { name: /next/i }).at(-1)).toBeDisabled();
  });
});
