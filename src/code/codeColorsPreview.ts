import './codeColorsPreview.css';
import { toFontFamily } from '../pane';
import { renderLine, tokenize } from './highlightStatic';
import { applyScheme, type Scheme } from './schemes';

/** A short TSX sample that exercises every role (docs/design/files.md section 4.22). */
export const PREVIEW_SNIPPET = `import { useState } from 'react';

// Shows a greeting
@observer
export class Greeting extends Component<Props> {
  render() {
    const [count] = useState(42);
    const text = 'Hello, ' + this.props.name;
    const valid = /^\\w+$/.test(text);
    return <Badge color="teal" count={count}>{text}</Badge>;
  }
}`;

const LINES = PREVIEW_SNIPPET.split('\n');

/**
 * The sample drawn in a scheme's own colors, set on the element itself so it shows a choice
 * before it is saved, and so do the text color and font, which the Settings tab passes from its
 * controls rather than waiting for the root's properties to follow a save.
 */
export class CodeColorsPreview {
  readonly el = document.createElement('pre');
  private readonly rows = LINES.map(() => document.createElement('div'));

  constructor() {
    this.el.className = 'code-colors-preview';
    this.el.setAttribute('aria-hidden', 'true');
    // The rows hold plain text until the TSX parser loads.
    LINES.forEach((line, i) => (this.rows[i].textContent = line || ' '));
    this.el.append(...this.rows);
    void tokenize(PREVIEW_SNIPPET, 'tsx')
      .then((lines) => {
        LINES.forEach((line, i) => renderLine(this.rows[i], line, lines[i]));
      })
      .catch(() => undefined);
  }

  update(scheme: Scheme, fontFamily: string, textColor: string): void {
    applyScheme(this.el, scheme);
    this.el.style.color = textColor;
    this.el.style.fontFamily = toFontFamily(fontFamily);
  }
}
