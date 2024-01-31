import { Hook, HookType } from './hook';
import { ChildPart, ChildValue } from './parts';
import type { ScopeInterface } from './scopeInterface';
import type { MountPoint, TemplateInterface } from './templateInterface';
import type { TemplateResult } from './templateResult';
import type { Renderable, RenderableBlock, Updater } from './updater';

const BlockFlag = {
  MOUNTED: 0b1,
  DIRTY: 0b10,
  UPDATING: 0b100,
};

export class Block<TProps, TContext>
  extends ChildValue
  implements RenderableBlock<TContext>
{
  private readonly _type: (props: TProps, context: TContext) => TemplateResult;

  private _pendingProps: TProps;

  private _pendingMountPoint: MountPoint | null = null;

  private _memoizedMountPoint: MountPoint | null = null;

  private _memoizedProps: TProps;

  private _memoizedTemplate: TemplateInterface | null = null;

  private _memoizedValues: unknown[] = [];

  private _cachedMountPoints: WeakMap<TemplateInterface, MountPoint> | null =
    null;

  private _flags: number = BlockFlag.DIRTY;

  private _hooks: Hook[] = [];

  private _parent: Renderable<TContext> | null = null;

  constructor(
    type: (props: TProps, context: TContext) => TemplateResult,
    props: TProps,
    parent: Renderable<TContext> | null = null,
  ) {
    super();
    this._type = type;
    this._pendingProps = props;
    this._memoizedProps = props;
    this._parent = parent;
  }

  get startNode(): ChildNode | null {
    return this._memoizedMountPoint?.children[0] ?? null;
  }

  get endNode(): ChildNode | null {
    if (this._memoizedMountPoint !== null) {
      const { children } = this._memoizedMountPoint;
      return children[children.length - 1]!;
    }
    return null;
  }

  get type(): (props: TProps, context: TContext) => TemplateResult {
    return this._type;
  }

  get props(): TProps {
    return this._memoizedProps;
  }

  get parent(): Renderable<TContext> | null {
    return this._parent;
  }

  get hooks(): Hook[] {
    return this._hooks;
  }

  get isDirty(): boolean {
    return (this._flags & BlockFlag.DIRTY) !== 0;
  }

  setProps(newProps: TProps): void {
    if (newProps !== this._pendingProps) {
      this._pendingProps = newProps;
      this._flags |= BlockFlag.DIRTY;
    }
  }

  forceUpdate(updater: Updater<TContext>): void {
    if (
      (this._flags & BlockFlag.MOUNTED) === 0 ||
      (this._flags & BlockFlag.UPDATING) !== 0
    ) {
      return;
    }

    this._flags |= BlockFlag.DIRTY | BlockFlag.UPDATING;
    updater.requestUpdate(this);
  }

  render(scope: ScopeInterface<TContext>, updater: Updater<TContext>): void {
    const render = this._type;
    const context = scope.createContext(this, updater);
    const { template, values } = render(this._pendingProps, context);

    if (this._memoizedMountPoint === null) {
      this._pendingMountPoint = template.mount(values, updater);
    } else if (this._memoizedTemplate !== template) {
      // The new template is different from the previous one. The
      // previous mount point is saved for future renders.
      if (this._cachedMountPoints === null) {
        // Since it is rare that different templates are returned, we defer
        // creating mount point caches.
        this._cachedMountPoints = new WeakMap();
        this._pendingMountPoint = template.mount(values, updater);
      } else {
        this._pendingMountPoint =
          this._cachedMountPoints.get(template) ??
          template.mount(values, updater);
      }

      // If a memoized mount point exists, a memoized template exists.
      this._cachedMountPoints.set(
        this._memoizedTemplate!,
        this._memoizedMountPoint,
      );
    } else {
      template.patch(
        this._memoizedMountPoint.parts,
        this._memoizedValues,
        values,
        updater,
      );
    }

    this._flags ^= BlockFlag.DIRTY | BlockFlag.UPDATING;
    this._memoizedProps = this._pendingProps;
    this._memoizedValues = values;
    this._memoizedTemplate = template;
  }

  mount(part: ChildPart, _updater: Updater): void {
    if (this._pendingMountPoint !== null) {
      connectMountPoint(this._pendingMountPoint, part);
    }

    this._flags |= BlockFlag.MOUNTED;
    this._memoizedMountPoint = this._pendingMountPoint;
  }

  unmount(_part: ChildPart, updater: Updater): void {
    for (let i = 0, l = this._hooks.length; i < l; i++) {
      const hook = this._hooks[i]!;
      if (
        hook.type === HookType.EFFECT ||
        hook.type === HookType.LAYOUT_EFFECT
      ) {
        hook.cleanup?.();
      }
    }

    if (this._memoizedMountPoint !== null) {
      disconnectMountPoint(this._memoizedMountPoint, updater);
    }

    this._flags ^= BlockFlag.MOUNTED;
  }

  update(part: ChildPart, updater: Updater): void {
    const oldMountPoint = this._memoizedMountPoint;
    const newMountPoint = this._pendingMountPoint;

    if (newMountPoint !== oldMountPoint) {
      if (oldMountPoint !== null) {
        disconnectMountPoint(oldMountPoint, updater);
      }

      if (newMountPoint !== null) {
        connectMountPoint(newMountPoint, part);
      }

      this._memoizedMountPoint = newMountPoint;
    }
  }
}

function connectMountPoint({ children }: MountPoint, part: ChildPart): void {
  const reference = part.endNode;
  const parent = reference.parentNode;

  if (parent !== null) {
    for (let i = 0, l = children.length; i < l; i++) {
      parent.insertBefore(children[i]!, reference);
    }
  }
}

function disconnectMountPoint(
  { children, parts }: MountPoint,
  updater: Updater,
): void {
  for (let i = 0, l = children.length; i < l; i++) {
    const node = children[i]!;
    if (node.isConnected) {
      node.remove();
    }
  }

  for (let i = 0, l = parts.length; i < l; i++) {
    const part = parts[i]!;
    part.disconnect(updater);
  }
}