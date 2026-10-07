import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  ApplicationToolbar,
  ToolButton,
  type ApplicationToolbarProps,
} from './applicationToolbar.js';
import { ZOOM_PRESET_PERCENTS } from './zoomPresets.js';

/**
 * The toolbar is now one component rendered by two screens -- the editor and the read-only revision
 * comparison -- so these tests are about the two properties that make that safe: every control is
 * present whatever the caller's state, and a control the caller says cannot act is **really**
 * disabled, not styled to look that way.
 *
 * "Really" means the DOM `disabled` attribute on a real control, which is what makes the element
 * non-focusable, un-clickable and announced as unavailable, all from one fact. A styled lookalike
 * with `aria-disabled` and a greyed colour would satisfy the eye and lie to the keyboard; the
 * assertions below check `toBeDisabled()` *and* that clicking fires nothing, so neither half can be
 * dropped without a failure here.
 */
function liveProps(): ApplicationToolbarProps {
  return {
    continuousScroll: { active: false, disabled: false, onClick: vi.fn() },
    elementLabels: { active: false, disabled: false, onClick: vi.fn() },
    elementSelector: {
      activeElement: 'action',
      disabled: false,
      onChange: vi.fn(),
      options: [
        { label: 'Scene Heading', value: 'scene_heading' },
        { label: 'Action', value: 'action' },
      ],
    },
    inspector: { active: true, disabled: false, onClick: vi.fn() },
    navigator: { active: true, disabled: false, onClick: vi.fn() },
    redo: { disabled: false, onClick: vi.fn() },
    undo: { disabled: false, onClick: vi.fn() },
    zoom: {
      fitModesDisabled: false,
      onChoosePreset: vi.fn(),
      onZoomIn: vi.fn(),
      onZoomOut: vi.fn(),
      percent: 100,
      presetValue: '100',
    },
  };
}

/** Everything a read-only snapshot comparison cannot do, exactly as the comparison route passes it. */
function readOnlyProps(): ApplicationToolbarProps {
  return {
    continuousScroll: { active: false, disabled: true },
    elementLabels: { active: false, disabled: true },
    elementSelector: { activeElement: undefined, disabled: true, options: [] },
    inspector: { active: true, disabled: false, onClick: vi.fn() },
    navigator: { active: true, disabled: false, onClick: vi.fn() },
    redo: { disabled: true },
    undo: { disabled: true },
    zoom: {
      fitModesDisabled: true,
      onChoosePreset: vi.fn(),
      onZoomIn: vi.fn(),
      onZoomOut: vi.fn(),
      percent: 100,
      presetValue: '100',
    },
  };
}

/** The toolbar's whole control inventory, by accessible name -- the list both screens must render in
 * full. A screen that cannot use a control renders it disabled, never absent. */
const CONTROL_NAMES = [
  'Undo local change',
  'Redo local change',
  'Active screenplay element',
  'Zoom out',
  'Zoom preset',
  'Zoom in',
  'Toggle element labels',
  'Toggle continuous scroll',
  'Toggle navigator',
  'Toggle inspector',
] as const;

function toolbar(): HTMLElement {
  return screen.getByRole('region', { name: 'Screenplay tools' });
}

describe('application toolbar: the controls it renders', () => {
  it('renders every control, by accessible name, whatever the caller can do with them', () => {
    const { rerender } = render(<ApplicationToolbar {...liveProps()} />);
    for (const name of CONTROL_NAMES) {
      expect(within(toolbar()).getByLabelText(name)).toBeInTheDocument();
    }

    rerender(<ApplicationToolbar {...readOnlyProps()} />);
    for (const name of CONTROL_NAMES) {
      expect(within(toolbar()).getByLabelText(name)).toBeInTheDocument();
    }
  });

  it('gives every icon-only button a title tooltip sourced from its accessible name', () => {
    render(<ApplicationToolbar {...liveProps()} />);
    for (const name of [
      'Undo local change',
      'Redo local change',
      'Zoom out',
      'Zoom in',
      'Toggle element labels',
      'Toggle continuous scroll',
      'Toggle navigator',
      'Toggle inspector',
    ]) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('title', name);
    }
  });

  it('offers the one preset list, from zoomPresets.ts, so both screens offer the same scales', () => {
    render(<ApplicationToolbar {...liveProps()} />);

    const preset = screen.getByRole('combobox', { name: 'Zoom preset' });
    expect(Array.from(preset.querySelectorAll('option')).map((option) => option.value)).toEqual([
      'fit-width',
      'fit-page',
      ...ZOOM_PRESET_PERCENTS.map(String),
    ]);
  });

  it('shows the caller’s percentage, rounded, in the announced output', () => {
    const props = liveProps();
    render(<ApplicationToolbar {...props} zoom={{ ...props.zoom, percent: 83.4 }} />);

    expect(screen.getByLabelText('Zoom level')).toHaveTextContent('83%');
  });
});

describe('application toolbar: the callbacks it fires', () => {
  it('fires each control’s own callback, and nobody else’s', async () => {
    const user = userEvent.setup();
    const props = liveProps();
    render(<ApplicationToolbar {...props} />);

    await user.click(screen.getByRole('button', { name: 'Undo local change' }));
    expect(props.undo.onClick).toHaveBeenCalledTimes(1);
    expect(props.redo.onClick).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Redo local change' }));
    expect(props.redo.onClick).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(props.zoom.onZoomIn).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(props.zoom.onZoomOut).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Toggle element labels' }));
    expect(props.elementLabels.onClick).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Toggle continuous scroll' }));
    expect(props.continuousScroll.onClick).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Toggle navigator' }));
    expect(props.navigator.onClick).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Toggle inspector' }));
    expect(props.inspector.onClick).toHaveBeenCalledTimes(1);
  });

  it('reports the chosen zoom preset as the option’s own value, fit modes included', async () => {
    const user = userEvent.setup();
    const props = liveProps();
    render(<ApplicationToolbar {...props} />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Zoom preset' }), '125');
    expect(props.zoom.onChoosePreset).toHaveBeenLastCalledWith('125');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Zoom preset' }), 'fit-width');
    expect(props.zoom.onChoosePreset).toHaveBeenLastCalledWith('fit-width');
  });

  it('reports the chosen element as its own value', async () => {
    const user = userEvent.setup();
    const props = liveProps();
    render(<ApplicationToolbar {...props} />);

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'scene_heading',
    );
    expect(props.elementSelector.onChange).toHaveBeenLastCalledWith('scene_heading');
  });

  it('reports a toggle’s state through aria-pressed and the active class', () => {
    const props = liveProps();
    render(
      <ApplicationToolbar
        {...props}
        elementLabels={{ ...props.elementLabels, active: true }}
        navigator={{ ...props.navigator, active: false }}
      />,
    );

    const labels = screen.getByRole('button', { name: 'Toggle element labels' });
    expect(labels).toHaveAttribute('aria-pressed', 'true');
    expect(labels).toHaveClass('active');
    const navigator = screen.getByRole('button', { name: 'Toggle navigator' });
    expect(navigator).toHaveAttribute('aria-pressed', 'false');
    expect(navigator).not.toHaveClass('active');
  });
});

/**
 * The property this whole extraction turns on, and the one the owner's instruction names explicitly:
 * "render it **genuinely disabled** -- the real `disabled` attribute on a real control, not a styled
 * lookalike, so assistive technology and keyboard navigation agree with what the eye sees."
 */
describe('application toolbar: disabled means disabled', () => {
  it('puts the real disabled attribute on every control a read-only screen cannot use', () => {
    render(<ApplicationToolbar {...readOnlyProps()} />);

    for (const name of [
      'Undo local change',
      'Redo local change',
      'Toggle element labels',
      'Toggle continuous scroll',
    ]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.getByRole('combobox', { name: 'Active screenplay element' })).toBeDisabled();
  });

  it('leaves the controls a read-only screen can use enabled', () => {
    render(<ApplicationToolbar {...readOnlyProps()} />);

    for (const name of ['Zoom out', 'Zoom in', 'Toggle navigator', 'Toggle inspector']) {
      expect(screen.getByRole('button', { name })).toBeEnabled();
    }
    expect(screen.getByRole('combobox', { name: 'Zoom preset' })).toBeEnabled();
  });

  /** A disabled control is unreachable, not merely unstyled: the keyboard cannot focus it and a click
   * cannot invoke it. Both halves fail if `disabled` is swapped for `aria-disabled` plus a class. */
  it('is unreachable by click and by keyboard when disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<ApplicationToolbar {...readOnlyProps()} undo={{ disabled: true, onClick }} />);

    const undo = screen.getByRole('button', { name: 'Undo local change' });
    await user.click(undo);
    expect(onClick).not.toHaveBeenCalled();

    undo.focus();
    expect(undo).not.toHaveFocus();
    await user.tab();
    expect(undo).not.toHaveFocus();
  });

  it('disables the two fit modes as real disabled options, keeping them present and named', () => {
    render(<ApplicationToolbar {...readOnlyProps()} />);

    const preset = screen.getByRole('combobox', { name: 'Zoom preset' });
    const options = Array.from(preset.querySelectorAll('option'));
    const byValue = (value: string) => options.find((option) => option.value === value);
    expect(byValue('fit-width')?.textContent).toBe('Fit width');
    expect(byValue('fit-page')?.textContent).toBe('Fit page');
    expect(byValue('fit-width')).toBeDisabled();
    expect(byValue('fit-page')).toBeDisabled();
    // Every percentage stays choosable: the comparison genuinely has a sheet to scale.
    for (const percent of ZOOM_PRESET_PERCENTS) {
      expect(byValue(String(percent))).toBeEnabled();
    }
  });

  it('leaves the fit modes choosable on a screen that can compute them', () => {
    render(<ApplicationToolbar {...liveProps()} />);

    const options = Array.from(
      screen.getByRole('combobox', { name: 'Zoom preset' }).querySelectorAll('option'),
    );
    expect(options.find((option) => option.value === 'fit-width')).toBeEnabled();
    expect(options.find((option) => option.value === 'fit-page')).toBeEnabled();
  });

  /** No active element is a fact, not a value to borrow: a screen with no caret shows a disabled
   * placeholder rather than a greyed-out element name that would read as the current one. */
  it('says there is no active element rather than naming one, when there is none', () => {
    render(<ApplicationToolbar {...readOnlyProps()} />);

    const select = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Active screenplay element',
    });
    expect(select.value).toBe('');
    const options = Array.from(select.querySelectorAll('option'));
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toBe('No active element');
    expect(options[0]).toBeDisabled();
  });

  it('selects the caller’s active element when there is one', () => {
    render(<ApplicationToolbar {...liveProps()} />);

    expect(screen.getByRole('combobox', { name: 'Active screenplay element' })).toHaveValue(
      'action',
    );
    expect(screen.queryByText('No active element')).toBeNull();
  });

  /** Nothing in this module may reach for `aria-disabled` instead: it is the attribute that makes a
   * control *look* unavailable to assistive technology while staying clickable and focusable. */
  it('uses no aria-disabled anywhere, on either screen', () => {
    const { rerender } = render(<ApplicationToolbar {...liveProps()} />);
    expect(toolbar().querySelectorAll('[aria-disabled]')).toHaveLength(0);
    rerender(<ApplicationToolbar {...readOnlyProps()} />);
    expect(toolbar().querySelectorAll('[aria-disabled]')).toHaveLength(0);
  });
});

describe('tool button', () => {
  it('is an enabled, titled, unpressed button by default', () => {
    render(<ToolButton label="Do the thing">x</ToolButton>);

    const button = screen.getByRole('button', { name: 'Do the thing' });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('title', 'Do the thing');
    expect(button).not.toHaveAttribute('aria-pressed');
    expect(button).toHaveClass('tool-button');
    expect(button).not.toHaveClass('active');
  });
});
