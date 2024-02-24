import { Directive, directiveSymbol } from '../directive.js';
import type { Part } from '../part.js';
import { ChildPart, ChildValue } from '../parts.js';
import type { Updater } from '../updater.js';

export function unsafeSVG(content: string): UnsafeSVG {
  return new UnsafeSVG(content);
}

export class UnsafeSVG implements Directive {
  private readonly _content: string;

  constructor(content: string) {
    this._content = content;
  }

  [directiveSymbol](part: Part, updater: Updater): void {
    if (!(part instanceof ChildPart)) {
      throw new Error(
        '"UnsafeSVG" directive must be used in an arbitrary child.',
      );
    }

    if (
      part.value instanceof UnsafeSVGChild &&
      part.value.content === this._content
    ) {
      // Skip the update if the same content is given.
      return;
    }

    part.setValue(new UnsafeSVG(this._content), updater);

    updater.enqueueMutationEffect(part);
  }
}

class UnsafeSVGChild extends ChildValue {
  private readonly _content: string;

  private _startNode: ChildNode | null = null;

  private _endNode: ChildNode | null = null;

  get content(): string {
    return this._content;
  }

  constructor(content: string) {
    super();
    this._content = content;
  }

  get startNode(): ChildNode | null {
    return this._startNode;
  }

  get endNode(): ChildNode | null {
    return this._endNode;
  }

  mount(part: ChildPart, _updater: Updater): void {
    const { endNode } = part;
    const range = document.createRange();
    const fragment = range.createContextualFragment(
      `<svg>${this._content}</svg>`,
    );
    const svg = fragment.firstChild!;

    this._startNode = svg.firstChild;
    this._endNode = svg.lastChild;

    endNode.parentNode?.insertBefore(endNode, fragment);
  }

  unmount(_part: ChildPart, _updater: Updater): void {
    let node = this._startNode;

    while (node !== null) {
      node.remove();
      if (node === this._endNode) {
        break;
      }
      node = node.nextSibling;
    }

    this._startNode = null;
    this._endNode = null;
  }

  update(_part: ChildPart, _updater: Updater): void {}
}
