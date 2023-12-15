const HoleType = {
  ATTRIBUTE: 1,
  EVENT: 2,
  CHILD: 3,
};

const BlockFlag = {
  MOUNTED: 0b001,
  UNMOUNTED: 0b010,
  DIRTY: 0b100,
};

const directiveSymbol = Symbol();

class Context {
  constructor(globalEnv = {}) {
    this._globalEnv = globalEnv;
    this._currentRenderable = null;
    this._pendingMutationEffects = [];
    this._pendingLayoutEffects = [];
    this._pendingPassiveEffects = [];
    this._pendingRenderables = [];
    this._isUpdating = false;
    this._hookIndex = 0;
    this._envStack = new WeakMap();
    this._templateCaches = new WeakMap();
    this._marker = '{{' + getUUID() + '}}';
  }

  get currentRenderable() {
    return this._currentRenderable;
  }

  html(strings, ...values) {
    let template = this._templateCaches.get(strings);

    if (!template) {
      template = Template.parse(strings, this._marker);
      this._templateCaches.set(strings, template);
    }

    return new TemplateResult(template, values);
  }

  useCallback(callback, dependencies) {
    return this.useMemo(() => callback, dependencies);
  }

  useEffect(setup, dependencies) {
    const { hooks } = this._currentRenderable;
    const oldHook = hooks[this._hookIndex];
    const newHook = (hooks[this._hookIndex] = new EffectHook(
      setup,
      dependencies,
    ));

    if (oldHook) {
      if (dependenciesAreChanged(oldHook.dependencies, dependencies)) {
        this.pushPassiveEffect(new Dispose(oldHook));
        this.pushPassiveEffect(newHook);
      }
    } else {
      this.pushPassiveEffect(newHook);
    }

    this._hookIndex++;
  }

  useEnv(name, defaultValue) {
    let renderable = this._currentRenderable;
    do {
      const env = this._envStack.get(renderable);
      if (env && Object.prototype.hasOwnProperty.call(env, name)) {
        return env[name];
      }
    } while ((renderable = renderable.parent));
    return this._globalEnv[name] ?? defaultValue;
  }

  useEvent(handler) {
    const handlerRef = this.useRef(null);

    this.useLayoutEffect(() => {
      handlerRef.current = handler;
    });

    return this.useCallback((...args) => {
      const currentHandler = handlerRef.current;
      return currentHandler(...args);
    }, []);
  }

  useLayoutEffect(setup, dependencies) {
    const { hooks } = this._currentRenderable;
    const oldHook = hooks[this._hookIndex];
    const newHook = (hooks[this._hookIndex] = new EffectHook(
      setup,
      dependencies,
    ));

    if (oldHook) {
      if (dependenciesAreChanged(oldHook.dependencies, dependencies)) {
        this.pushPassiveEffect(new Dispose(oldHook));
        this.pushLayoutEffect(newHook);
      }
    } else {
      this.pushLayoutEffect(newHook);
    }

    this._hookIndex++;
  }

  useMemo(create, dependencies) {
    const block = this._currentRenderable;
    const { hooks } = block;
    let hook = hooks[this._hookIndex];

    if (hook) {
      if (dependenciesAreChanged(hook.dependencies, dependencies)) {
        hook.value = Array.isArray(dependencies)
          ? create(...dependencies)
          : create();
      }
      hook.dependencies = dependencies;
    } else {
      const value = Array.isArray(dependencies)
        ? create(...dependencies)
        : create();
      hook = hooks[this._hookIndex] = {
        value,
        dependencies,
      };
    }

    this._hookIndex++;

    return hook.value;
  }

  useReducer(reducer, initialState) {
    const block = this._currentRenderable;
    const { hooks } = block;
    let hook = hooks[this._hookIndex];

    if (!hook) {
      hook = hooks[this._hookIndex] = {
        state: initialState,
        dispatch: (action) => {
          hook.state = reducer(hook.state, action);
          block.scheduleUpdate(this);
        },
      };
    }

    this._hookIndex++;

    return [hook.state, hook.dispatch];
  }

  useRef(initialValue) {
    const { hooks } = this._currentRenderable;
    let hook = hooks[this._hookIndex];

    if (!hook) {
      hook = hooks[this._hookIndex] = new Ref(initialValue);
    }

    this._hookIndex++;

    return hook;
  }

  useSignal(signal) {
    const block = this._currentRenderable;
    this.useEffect(() => {
      return signal.subscribe(() => {
        block.scheduleUpdate(this);
      });
    }, [signal]);
    return signal;
  }

  useState(initialState) {
    return this.useReducer(
      (state, action) =>
        typeof action === 'function' ? action(state) : action,
      initialState,
    );
  }

  useSyncEnternalStore(subscribe, getSnapshot) {
    const block = this._currentRenderable;
    this.useEffect(() => {
      return subscribe(() => {
        block.scheduleUpdate(this);
      });
    }, [subscribe]);
    return getSnapshot();
  }

  setEnv(env) {
    this._envStack.set(this._currentRenderable, env);
  }

  requestUpdate(renderable) {
    if (this._currentRenderable) {
      if (this._currentRenderable !== renderable) {
        this._pendingRenderables.push(renderable);
      }
    } else {
      this._pendingRenderables.push(renderable);
      if (!this._isUpdating) {
        this._isUpdating = true;
        this._startRenderingPhase();
      }
    }
  }

  requestMutations() {
    if (!this._isUpdating && this._pendingMutationEffects.length > 0) {
      this._isUpdating = true;
      this._startBlockingPhase();
    }
  }

  pushMutationEffect(effect) {
    this._pendingMutationEffects.push(effect);
  }

  pushLayoutEffect(effect) {
    this._pendingLayoutEffects.push(effect);
  }

  pushPassiveEffect(effect) {
    this._pendingPassiveEffects.push(effect);
  }

  _startRenderingPhase() {
    scheduler.postTask(this._renderingPhase, {
      priority: 'background',
    });
  }

  _startBlockingPhase() {
    scheduler.postTask(this._blockingPhase, {
      priority: 'user-blocking',
    });
  }

  _startPassiveEffectPhase() {
    scheduler.postTask(this._passiveEffectPhase, {
      priority: 'background',
    });
  }

  _renderingPhase = async () => {
    console.time('Rendering phase');

    for (let i = 0; i < this._pendingRenderables.length; i++) {
      if (navigator.scheduling.isInputPending()) {
        await yieldToMain();
      }
      const renderable = this._pendingRenderables[i];
      if (renderable.isDirty && !ancestorIsDirty(renderable)) {
        this._hookIndex = 0;
        this._currentRenderable = renderable;
        this._currentRenderable.render(this);
        this._currentRenderable = null;
      }
    }

    this._pendingRenderables.length = 0;

    if (
      this._pendingMutationEffects.length > 0 ||
      this._pendingLayoutEffects.length > 0
    ) {
      this._startBlockingPhase();
    } else if (this._pendingPassiveEffects.length > 0) {
      this._startPassiveEffectPhase();
    } else {
      this._isUpdating = false;
    }

    console.timeEnd('Rendering phase');
  };

  _blockingPhase = async () => {
    console.time('Blocking phase');

    for (let i = 0; i < this._pendingMutationEffects.length; i++) {
      if (navigator.scheduling.isInputPending()) {
        await yieldToMain();
      }
      this._pendingMutationEffects[i].commit(this);
    }

    this._pendingMutationEffects.length = 0;

    for (let i = 0; i < this._pendingLayoutEffects.length; i++) {
      if (navigator.scheduling.isInputPending()) {
        await yieldToMain();
      }
      this._pendingLayoutEffects[i].commit(this);
    }

    this._pendingLayoutEffects.length = 0;

    if (this._pendingPassiveEffects.length > 0) {
      this._startPassiveEffectPhase();
    } else if (this._pendingRenderables.length > 0) {
      this._startRenderingPhase();
    } else {
      this._isUpdating = false;
    }

    console.timeEnd('Blocking phase');
  };

  _passiveEffectPhase = async () => {
    console.time('Passive effect phase');

    for (let i = 0; i < this._pendingPassiveEffects.length; i++) {
      if (navigator.scheduling.isInputPending()) {
        await yieldToMain();
      }
      this._pendingPassiveEffects[i].commit(this);
    }

    this._pendingPassiveEffects.length = 0;

    if (this._pendingRenderables.length > 0) {
      this._startRenderingPhase();
    } else if (
      this._pendingMutationEffects.length > 0 ||
      this._pendingLayoutEffects.length > 0
    ) {
      this._startBlockingPhase();
    } else {
      this._isUpdating = false;
    }

    console.timeEnd('Passive effect phase');
  };
}

class Template {
  static parse(strings, marker) {
    const html = strings.join(marker).trim();
    const template = document.createElement('template');
    template.innerHTML = html;
    const holes = [];
    parseChildren(template.content, marker, holes, []);
    return new Template(template, holes);
  }

  constructor(template, holes) {
    this._template = template;
    this._holes = holes;
  }

  mount(values, context) {
    const node = this._template.content.cloneNode(true);
    const parts = new Array(this._holes.length);
    const cleanups = new Array(this._holes.length);

    for (let i = 0, l = this._holes.length; i < l; i++) {
      const hole = this._holes[i];

      let child = node;

      for (let j = 0, m = hole.path.length; j < m; j++) {
        child = child.childNodes[hole.path[j]];
      }

      child = child.childNodes[hole.index];

      let part;

      if (hole.type === HoleType.ATTRIBUTE) {
        part = new AttributePart(child, hole.name);
      } else if (hole.type === HoleType.EVENT) {
        part = new EventPart(child, hole.name);
      } else {
        //  hole.type === HoleType.CHILD
        part = new ChildPart(child);
      }

      cleanups[i] = mountPart(part, values[i], context);
      parts[i] = part;
    }

    return { node, parts, cleanups };
  }

  patch(parts, oldValues, newValues, cleanups, context) {
    for (let i = 0, l = this._holes.length; i < l; i++) {
      cleanups[i] = updatePart(
        parts[i],
        oldValues[i],
        newValues[i],
        cleanups[i],
        context,
      );
    }
  }
}

class AttributePart {
  constructor(element, name) {
    this._element = element;
    this._name = name;
    this._committedValue = null;
    this._pendingValue = null;
  }

  get node() {
    return this._element;
  }

  get value() {
    return this._committedValue;
  }

  setValue(newValue) {
    this._pendingValue = newValue;
  }

  commit(_context) {
    const { _element: element, _name: name, _pendingValue: newValue } = this;

    if (newValue === true) {
      element.setAttribute(name, '');
    } else if (newValue === false || newValue == null) {
      element.removeAttribute(name);
    } else {
      element.setAttribute(name, newValue.toString());
    }

    this._committedValue = newValue;
  }
}

class EventPart {
  constructor(element, eventName) {
    this._element = element;
    this._eventName = eventName;
    this._committedValue = null;
    this._pendingValue = null;
  }

  get node() {
    return this._element;
  }

  get value() {
    return this._committedValue;
  }

  setValue(newValue) {
    this._pendingValue = newValue;
  }

  commit(_context) {
    const {
      _element: element,
      _eventName: eventName,
      _committedValue: oldValue,
      _pendingValue: newValue,
    } = this;

    if (oldValue != null) {
      element.removeEventListener(eventName, oldValue);
    }

    if (newValue != null) {
      element.addEventListener(eventName, newValue);
    }

    this._committedValue = newValue;
  }
}

class ChildPart {
  constructor(node) {
    this._node = node;
    this._committedValue = null;
    this._pendingValue = null;
  }

  get startNode() {
    return this._committedValue
      ? this._committedValue.startNode ?? this._node
      : this._node;
  }

  get endNode() {
    return this._node;
  }

  get value() {
    return this._committedValue;
  }

  setValue(newValue) {
    this._pendingValue = Child.fromValue(newValue, this._committedValue);
  }

  commit(context) {
    const oldValue = this._committedValue;
    const newValue = this._pendingValue;

    if (oldValue !== newValue) {
      if (oldValue) {
        oldValue.unmount(this, context);
      }
      newValue.mount(this, context);
    }

    newValue.commit(context);

    this._committedValue = newValue;
  }

  dispose(context) {
    if (this._node.isConnected) {
      this._node.remove();
    }
    if (this._committedValue) {
      this._committedValue.unmount(this, context);
    }
  }
}

class ItemPart extends ChildPart {
  constructor(node, containerPart) {
    super(node);
    this._containerPart = containerPart;
  }

  commit(context) {
    if (!this._node.isConnected) {
      const reference = this._containerPart.endNode;
      reference.parentNode.insertBefore(this._node, reference);
    }

    super.commit(context);
  }
}

class Child {
  static fromValue(value, oldChild) {
    if (value instanceof Child) {
      return value;
    } else if (value === null) {
      return Empty.instance;
    } else if (oldChild instanceof Text) {
      oldChild.setValue(value);
      return oldChild;
    } else {
      return new Text(value);
    }
  }

  get startNode() {
    return null;
  }

  get endNode() {
    return null;
  }

  mount(_part, _context) {}

  unmount(_part, _context) {}

  commit(_context) {}
}

class Text extends Child {
  constructor(value) {
    super();
    this._value = value;
    this._node = document.createTextNode('');
  }

  get startNode() {
    return this._node;
  }

  get endNode() {
    return this._node;
  }

  get value() {
    return this._value;
  }

  setValue(newValue) {
    this._value = newValue;
  }

  mount(part, _context) {
    const reference = part.endNode;
    reference.parentNode.insertBefore(this._node, reference);
  }

  unmount(_part, _context) {
    if (this._node.isConnected) {
      this._node.remove();
    }
  }

  commit(_context) {
    this._node.textContent = this._value.toString();
  }
}

class List extends Child {
  constructor(items, valueSelector, keySelector, containerPart, context) {
    super();
    const parts = new Array(items.length);
    const values = new Array(items.length);
    const keys = new Array(items.length);
    const cleanups = new Array(items.length);
    for (let i = 0, l = items.length; i < l; i++) {
      const item = items[i];
      const part = new ItemPart(createMarkerNode(), containerPart);
      const value = valueSelector(item, i);
      const key = keySelector(item, i);
      cleanups[i] = mountPart(part, value, context);
      parts[i] = part;
      values[i] = value;
      keys[i] = key;
    }
    this._containerPart = containerPart;
    this._commitedParts = [];
    this._commitedValues = [];
    this._commitedKeys = [];
    this._pendingParts = parts;
    this._pendingValues = values;
    this._pendingKeys = keys;
    this._cleanups = cleanups;
  }

  get startNode() {
    const parts = this._commitedParts;
    return parts.length > 0 ? parts[0].startNode : null;
  }

  get endNode() {
    const parts = this._commitedParts;
    return parts.length > 0 ? parts[parts.length - 1].endNode : null;
  }

  updateItems(newItems, valueSelector, keySelector, context) {
    const oldParts = this._commitedParts;
    const oldValues = this._commitedValues;
    const oldKeys = this._commitedKeys;
    const oldCleanups = this._cleanups;
    const newParts = new Array(newItems.length);
    const newValues = newItems.map(valueSelector);
    const newKeys = newItems.map(keySelector);
    const newCleanups = new Array(newItems.length);

    // Head and tail pointers to old parts and new values
    let oldHead = 0;
    let oldTail = oldParts.length - 1;
    let newHead = 0;
    let newTail = newValues.length - 1;

    let newKeyToIndexMap;
    let oldKeyToIndexMap;

    while (oldHead <= oldTail && newHead <= newTail) {
      if (oldParts[oldHead] === null) {
        // `null` means old part at head has already been used
        // below; skip
        oldHead++;
      } else if (oldParts[oldTail] === null) {
        // `null` means old part at tail has already been used
        // below; skip
        oldTail--;
      } else if (oldKeys[oldHead] === newKeys[newHead]) {
        // Old head matches new head; update in place
        const part = oldParts[oldHead];
        newCleanups[newHead] = updatePart(
          part,
          oldValues[oldHead],
          newValues[newHead],
          oldCleanups[oldHead],
          context,
        );
        newParts[newHead] = part;
        oldHead++;
        newHead++;
      } else if (oldKeys[oldTail] === newKeys[newTail]) {
        // Old tail matches new tail; update in place
        const part = oldParts[oldTail];
        newCleanups[newTail] = updatePart(
          part,
          oldValues[oldTail],
          newValues[newTail],
          oldCleanups[oldTail],
          context,
        );
        newParts[newTail] = part;
        oldTail--;
        newTail--;
      } else if (oldKeys[oldHead] === newKeys[newTail]) {
        // Old tail matches new head; update and move to new head
        const part = oldParts[oldHead];
        context.pushMutationEffect(
          new ReorderItemPart(part, newParts[newTail + 1] ?? null),
        );
        newCleanups[newTail] = updatePart(
          part,
          oldValues[oldHead],
          newValues[newTail],
          oldCleanups[oldHead],
          context,
        );
        newParts[newTail] = part;
        oldHead++;
        newTail--;
      } else if (oldKeys[oldTail] === newKeys[newHead]) {
        // Old tail matches new head; update and move to new head
        const part = oldParts[oldTail];
        context.pushMutationEffect(
          new ReorderItemPart(part, oldParts[oldHead]),
        );
        newCleanups[newHead] = updatePart(
          part,
          oldValues[oldTail],
          newValues[newHead],
          oldCleanups[oldTail],
          context,
        );
        newParts[newHead] = part;
        oldTail--;
        newHead++;
      } else {
        if (newKeyToIndexMap === undefined) {
          // Lazily generate key-to-index maps, used for removals &
          // moves below
          newKeyToIndexMap = generateMap(newKeys, newHead, newTail);
          oldKeyToIndexMap = generateMap(oldKeys, oldHead, oldTail);
        }
        if (!newKeyToIndexMap.has(oldKeys[oldHead])) {
          // Old head is no longer in new list; remove
          const part = oldParts[oldHead];
          context.pushMutationEffect(new Dispose(part));
          oldCleanups[oldHead]?.call();
          oldHead++;
        } else if (!newKeyToIndexMap.has(oldKeys[oldTail])) {
          // Old tail is no longer in new list; remove
          const part = oldParts[oldTail];
          context.pushMutationEffect(new Dispose(part));
          oldCleanups[oldTail]?.call();
          oldTail--;
        } else {
          // Any mismatches at this point are due to additions or
          // moves; see if we have an old part we can reuse and move
          // into place
          const oldIndex = oldKeyToIndexMap.get(newKeys[newHead]);
          if (oldIndex !== undefined) {
            // Reuse old part
            const oldPart = oldParts[oldIndex];
            context.pushMutationEffect(
              new ReorderItemPart(oldPart, oldParts[oldHead]),
            );
            newCleanups[newHead] = updatePart(
              oldPart,
              oldValues[oldHead],
              newValues[newHead],
              oldCleanups[oldHead],
              context,
            );
            newParts[newHead] = oldPart;
            // This marks the old part as having been used, so that
            // it will be skipped in the first two checks above
            oldParts[oldIndex] = null;
          } else {
            // No old part for this value; create a new one and
            // insert it
            const part = new ItemPart(createMarkerNode(), this._containerPart);
            newCleanups[newHead] = mountPart(part, newValues[newHead], context);
            newParts[newHead] = part;
          }
          newHead++;
        }
      }
    }

    // Add parts for any remaining new values
    while (newHead <= newTail) {
      // For all remaining additions, we insert before last new
      // tail, since old pointers are no longer valid
      const newPart = new ItemPart(createMarkerNode(), this._containerPart);
      newCleanups[newHead] = mountPart(newPart, newValues[newHead], context);
      newParts[newHead] = newPart;
      newHead++;
    }

    // Remove any remaining unused old parts
    while (oldHead <= oldTail) {
      const oldPart = oldParts[oldHead];
      if (oldPart !== null) {
        context.pushMutationEffect(new Dispose(oldPart));
      }
      oldCleanups[oldHead]?.call();
      oldHead++;
    }

    this._pendingParts = newParts;
    this._pendingValues = newValues;
    this._pendingKeys = newKeys;
    this._cleanups = newCleanups;
  }

  mount(_part, _context) {}

  unmount(_part, context) {
    for (let i = 0, l = this._commitedParts.length; i < l; i++) {
      this._commitedParts[i].dispose(context);
    }
    for (let i = 0, l = this._cleanups.length; i < l; i++) {
      this._cleanups[i]?.call();
    }
  }

  commit(_context) {
    this._commitedParts = this._pendingParts;
    this._commitedValues = this._pendingValues;
    this._commitedKeys = this._pendingKeys;
  }
}

class Fragment extends Child {
  static fromTemplateResult(templateResult) {
    return new Fragment(templateResult.template, templateResult.values, null);
  }

  constructor(template, values, parent) {
    super();
    this._template = template;
    this._pendingValues = values;
    this._memoizedValues = null;
    this._parent = parent;
    this._nodes = [];
    this._parts = [];
    this._cleanups = [];
  }

  get startNode() {
    return this._nodes[0] ?? null;
  }

  get endNode() {
    return this._nodes[this._nodes.length - 1] ?? null;
  }

  get parent() {
    return this._parent;
  }

  get template() {
    return this._template;
  }

  get isDirty() {
    return this._memoizedValues !== this._pendingValues;
  }

  setValues(values) {
    this._pendingValues = values;
  }

  mount(part, _context) {
    const reference = part.endNode;
    const parent = reference.parentNode;

    for (let i = 0, l = this._nodes.length; i < l; i++) {
      parent.insertBefore(this._nodes[i], reference);
    }
  }

  unmount(_part, context) {
    for (let i = 0, l = this._nodes.length; i < l; i++) {
      const node = this._nodes[i];
      if (node.isConnected) {
        node.remove();
      }
    }

    for (let i = 0, l = this._parts.length; i < l; i++) {
      const part = this._parts[i];
      if (part instanceof ChildPart) {
        part.dispose(context);
      }
    }

    for (let i = 0, l = this._cleanups.length; i < l; i++) {
      this._cleanups[i]?.call();
    }
  }

  render(context) {
    if (this._memoizedValues === null) {
      const { node, parts, cleanups } = this._template.mount(
        this._pendingValues,
        context,
      );
      this._nodes = Array.from(node.childNodes);
      this._parts = parts;
      this._cleanups = cleanups;
    } else {
      this._template.patch(
        this._parts,
        this._memoizedValues,
        this._pendingValues,
        this._cleanups,
        context,
      );
    }

    this._memoizedValues = this._pendingValues;
  }
}

class Block extends Child {
  constructor(type, props, parent = null) {
    super();
    this._type = type;
    this._pendingProps = props;
    this._memoizedProps = props;
    this._memoizedValues = null;
    this._parent = parent;
    this._flags = BlockFlag.DIRTY;
    this._nodes = [];
    this._parts = [];
    this._hooks = [];
    this._cleanups = [];
  }

  get startNode() {
    return this._nodes[0] ?? null;
  }

  get endNode() {
    return this._nodes[this._nodes.length - 1] ?? null;
  }

  get type() {
    return this._type;
  }

  get props() {
    return this._memoizedProps;
  }

  get parent() {
    return this._parent;
  }

  get hooks() {
    return this._hooks;
  }

  get isDirty() {
    return (this._flags & BlockFlag.DIRTY) !== 0;
  }

  setProps(newProps) {
    this._pendingProps = newProps;
  }

  scheduleUpdate(context) {
    const needsUpdate =
      (this._flags & BlockFlag.MOUNTED) !== 0 &&
      (this._flags & BlockFlag.UNMOUNTED) === 0 &&
      (this._flags & BlockFlag.DIRTY) === 0;

    if (needsUpdate) {
      this._flags |= BlockFlag.DIRTY;
      context.requestUpdate(this);
    }
  }

  render(context) {
    if (this._memoizedValues === null) {
      const render = this._type;
      const { template, values } = render(this._pendingProps, context);
      const { node, parts, cleanups } = template.mount(values, context);
      this._nodes = Array.from(node.childNodes);
      this._parts = parts;
      this._cleanups = cleanups;
      this._memoizedValues = values;
    } else {
      const render = this._type;
      const { template, values } = render(this._pendingProps, context);
      template.patch(
        this._parts,
        this._memoizedValues,
        values,
        this._cleanups,
        context,
      );
      this._memoizedValues = values;
    }

    this._flags ^= BlockFlag.DIRTY;
    this._memoizedProps = this._pendingProps;
  }

  mount(part, _context) {
    const reference = part.endNode;
    const parent = reference.parentNode;

    for (let i = 0, l = this._nodes.length; i < l; i++) {
      parent.insertBefore(this._nodes[i], reference);
    }

    this._flags |= BlockFlag.MOUNTED;
  }

  unmount(_part, context) {
    for (let i = 0, l = this._nodes.length; i < l; i++) {
      const node = this._nodes[i];
      if (node.isConnected) {
        node.remove();
      }
    }

    for (let i = 0, l = this._hooks.length; i < l; i++) {
      const hook = this._hooks[i];
      if (hook instanceof EffectHook || hook instanceof SignalHook) {
        hook.dispose(context);
      }
    }

    for (let i = 0, l = this._parts.length; i < l; i++) {
      const part = this._parts[i];
      if (part instanceof ChildPart) {
        part.dispose(context);
      }
    }

    for (let i = 0, l = this._cleanups.length; i < l; i++) {
      this._cleanups[i]?.call();
    }

    this._flags |= BlockFlag.UNMOUNTED;
    this._flags ^= BlockFlag.DIRTY;
  }
}

class Empty extends Child {
  static instance = new Empty();
}

class Ref {
  constructor(initialValue) {
    this.current = initialValue;
  }

  [directiveSymbol](part, _context) {
    this.current = part.node;
  }
}

class BlockDirective {
  constructor(type, props) {
    this._type = type;
    this._props = props;
  }

  get type() {
    return this._type;
  }

  get props() {
    return this._props;
  }

  [directiveSymbol](part, context) {
    const value = part.value;

    let needsMount = false;

    if (value instanceof Block) {
      if (value.type === this._type) {
        value.setProps(this._props);
        value.scheduleUpdate(context);
      } else {
        needsMount = true;
      }
    } else {
      needsMount = true;
    }

    if (needsMount) {
      const newBlock = new Block(
        this._type,
        this._props,
        context.currentRenderable,
      );
      part.setValue(newBlock);
      context.requestUpdate(newBlock);
      context.pushMutationEffect(part);
    }
  }
}

class ListDirective {
  constructor(items, valueSelector, keySelector) {
    this._items = items;
    this._valueSelector = valueSelector;
    this._keySelector = keySelector;
  }

  [directiveSymbol](part, context) {
    const value = part.value;

    if (value instanceof List) {
      value.updateItems(
        this._items,
        this._valueSelector,
        this._keySelector,
        context,
      );
    } else {
      const list = new List(
        this._items,
        this._valueSelector,
        this._keySelector,
        part,
        context,
      );
      part.setValue(list, context);
    }

    context.pushMutationEffect(part);
  }
}

class TemplateResult {
  constructor(template, values) {
    this._template = template;
    this._values = values;
  }

  get template() {
    return this._template;
  }

  get values() {
    return this._values;
  }

  [directiveSymbol](part, context) {
    const value = part.value;

    let needsMount = false;

    if (value instanceof Fragment) {
      if (value.template === this._template) {
        const needsRequestUpdate = !value.isDirty;
        value.setValues(this._values);
        if (needsRequestUpdate) {
          context.requestUpdate(value);
        }
      } else {
        needsMount = true;
      }
    } else {
      needsMount = true;
    }

    if (needsMount) {
      const newFragment = new Fragment(
        this._template,
        this._values,
        context.currentRenderable,
      );
      part.setValue(newFragment, context);
      context.requestUpdate(newFragment);
      context.pushMutationEffect(part);
    }
  }
}

class Signal {
  get value() {
    return null;
  }

  subscribe(_subscriber) {
    return () => {};
  }

  [directiveSymbol](part, context) {
    const value = this.value;

    let cleanup;

    if (isDirective(value)) {
      cleanup = value[directiveSymbol](part, context);
    } else {
      part.setValue(value);
      context.pushMutationEffect(part);
    }

    const subscription = this.subscribe(() => {
      const value = this.value;

      if (cleanup) {
        cleanup();
        cleanup = undefined;
      }

      if (isDirective(value)) {
        cleanup = value[directiveSymbol](part, context);
      } else {
        part.setValue(value);
        context.pushMutationEffect(part);
      }

      context.requestMutations();
    });

    return () => {
      cleanup?.call();
      subscription();
    };
  }

  map(selector) {
    return new ProjectedSignal(this, selector);
  }
}

class AtomSignal extends Signal {
  constructor(initialValue) {
    super();
    this._value = initialValue;
    this._subscribers = [];
  }

  get value() {
    return this._value;
  }

  set value(newValue) {
    this._value = newValue;
    for (let i = 0, l = this._subscribers.length; i < l; i++) {
      this._subscribers[i]();
    }
  }

  subscribe(subscriber) {
    this._subscribers.push(subscriber);
    return () => {
      const i = this._subscribers.indexOf(subscriber);
      if (i >= 0) {
        this._subscribers.splice(i, 1);
      }
    };
  }
}

class ProjectedSignal extends Signal {
  constructor(signal, selectorFn) {
    super();
    this._signal = signal;
    this._selectorFn = selectorFn;
  }

  get value() {
    const selectorFn = this._selectorFn;
    return selectorFn(this._signal.value);
  }

  subscribe(subscriber) {
    return this._signal.subscribe(subscriber);
  }
}

class ComputedSignal extends Signal {
  constructor(computeFn, signals) {
    super();
    this._computeFn = computeFn;
    this._signals = signals;
    this._memoizedDependencies = null;
    this._computedValue = null;
  }

  get value() {
    const newDependencies = this._signals.map((signal) => signal.value);
    if (!shallowEqual(this._memoizedDependencies, newDependencies)) {
      const computeFn = this._computeFn;
      this._memoizedDependencies = newDependencies;
      this._computedValue = computeFn(...newDependencies);
    }
    return this._computedValue;
  }

  subscribe(subscriber) {
    const subscriptions = this._signals.map((signal) =>
      signal.subscribe(subscriber),
    );
    return () => {
      for (let i = 0, l = subscriptions.length; i < l; i++) {
        subscriptions[i]();
      }
    };
  }
}

class EffectHook {
  constructor(setup, dependencies) {
    this._setup = setup;
    this._dependencies = dependencies;
    this._destroy = null;
  }

  get dependencies() {
    return this._dependencies;
  }

  commit(_context) {
    const setup = this._setup;
    const dependencies = this._dependencies;
    this._destroy = Array.isArray(dependencies)
      ? setup(...dependencies)
      : setup();
  }

  dispose(context) {
    if (this._destroy) {
      this._destroy(context);
      this._destroy = null;
    }
  }
}

class SignalHook {
  constructor(signal, subscription) {
    this._signal = signal;
    this._subscription = subscription;
  }

  get signal() {
    return this._signal;
  }

  dispose(_context) {
    if (this._subscription) {
      this._subscription();
      this._subscription = null;
    }
  }
}

class Dispose {
  constructor(disposable) {
    this._disposable = disposable;
  }

  commit(context) {
    this._disposable.dispose(context);
  }
}

class ReorderItemPart {
  constructor(part, referencePart) {
    this._part = part;
    this._referencePart = referencePart;
  }

  commit(context) {
    this._part.reorder(this._referencePart, context);
  }
}

function block(type, props = {}) {
  return new BlockDirective(type, props);
}

function list(
  items,
  valueSelector = defaultItemValueSelector,
  keySelector = defaultItemKeySelector,
) {
  return new ListDirective(items, valueSelector, keySelector);
}

function ancestorIsDirty(renderable) {
  while ((renderable = renderable.parent)) {
    if (renderable.isDirty) {
      return true;
    }
  }
  return false;
}

function boot(container, renderable, context) {
  context.pushLayoutEffect({
    commit(context) {
      const node = createMarkerNode();
      container.appendChild(node);
      renderable.mount(new ChildPart(node), context);
    },
  });
  context.requestUpdate(renderable);
}

function createMarkerNode(name = '') {
  return document.createComment(name);
}

function defaultItemKeySelector(_value, index) {
  return index;
}

function defaultItemValueSelector(value, _index) {
  return value;
}

function dependenciesAreChanged(oldDependencies, newDependencies) {
  return (
    oldDependencies === undefined ||
    newDependencies === undefined ||
    !shallowEqual(oldDependencies, newDependencies)
  );
}

function generateMap(list, start, end) {
  const map = new Map();
  for (let i = start; i <= end; i++) {
    map.set(list[i], i);
  }
  return map;
}

function getUUID() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  const s = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return (
    s.slice(0, 8) +
    '-' +
    s.slice(8, 12) +
    '-' +
    s.slice(12, 16) +
    '-' +
    s.slice(16, 20) +
    '-' +
    s.slice(20, 32)
  );
}

function isDirective(value) {
  return typeof value === 'object' && directiveSymbol in value;
}

function mountPart(part, value, context) {
  let cleanup;

  if (isDirective(value)) {
    cleanup = value[directiveSymbol](part, context);
  } else {
    part.setValue(value);
    context.pushMutationEffect(part);
  }

  return cleanup;
}

function parseAttribtues(node, marker, holes, path, index) {
  const { attributes } = node;
  for (let i = 0, l = attributes.length; i < l; i++) {
    const attribute = attributes[i];
    if (attribute.value === marker) {
      const name = attribute.name;
      if (
        name.length > 2 &&
        (name[0] === 'o' || name[0] === 'O') &&
        (name[1] === 'n' || name[1] === 'N')
      ) {
        holes.push({
          type: HoleType.EVENT,
          path,
          index,
          name: attribute.name.slice(2),
        });
      } else {
        holes.push({
          type: HoleType.ATTRIBUTE,
          path,
          index,
          name,
        });
      }
      node.removeAttribute(attribute.name);
    }
  }
}

function parseChildren(node, marker, holes, path) {
  const { childNodes } = node;

  for (let i = 0, l = childNodes.length; i < l; i++) {
    const child = childNodes[i];
    switch (child.nodeType) {
      case Node.ELEMENT_NODE:
        parseAttribtues(child, marker, holes, path, i);
        if (child.childNodes.length > 0) {
          parseChildren(child, marker, holes, [...path, i]);
        }
        break;
      case Node.TEXT_NODE: {
        const components = child.textContent.split(marker);
        if (components.length <= 1) {
          continue;
        }

        const componentEnd = components.length - 1;
        for (let j = 0; j < componentEnd; j++) {
          if (components[j] !== '') {
            const text = document.createTextNode(components[j]);
            node.insertBefore(text, child);
            i++;
            l++;
          }

          holes.push({
            type: HoleType.CHILD,
            path,
            index: i,
          });

          node.insertBefore(createMarkerNode(), child);
          i++;
          l++;
        }

        if (components[componentEnd] !== '') {
          child.textContent = components[componentEnd];
        } else {
          child.remove();
          i--;
          l--;
        }
        break;
      }
    }
  }
}

function shallowEqual(first, second) {
  if (Object.is(first, second)) {
    return true;
  }

  if (
    typeof first !== 'object' ||
    first === null ||
    typeof second !== 'object' ||
    second === null
  ) {
    return false;
  }

  if (Object.getPrototypeOf(first) !== Object.getPrototypeOf(second)) {
    return false;
  }

  const firstKeys = Object.keys(first);
  const secondKeys = Object.keys(second);

  if (firstKeys.length !== secondKeys.length) {
    return false;
  }

  for (let i = 0, l = firstKeys.length; i < l; i++) {
    if (
      !Object.prototype.hasOwnProperty.call(second, firstKeys[i]) ||
      !Object.is(first[firstKeys[i]], second[firstKeys[i]])
    ) {
      return false;
    }
  }

  return true;
}

function updatePart(part, oldValue, newValue, oldCleanup, context) {
  let newCleanup;

  if (Object.is(oldValue, newValue)) {
    newCleanup = oldCleanup;
  } else {
    oldCleanup?.call();

    if (isDirective(newValue)) {
      newCleanup = newValue[directiveSymbol](part, context);
    } else {
      part.setValue(newValue);
      context.pushMutationEffect(part);
    }
  }

  return newCleanup;
}

function yieldToMain() {
  if ('scheduler' in globalThis && 'yield' in scheduler) {
    return scheduler.yield();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const counterSignal = new AtomSignal(0);

function App(_props, context) {
  const [items, setItems] = context.useState([
    'foo',
    'bar',
    'baz',
    'qux',
    'quux',
  ]);

  context.setEnv({ state: 'My Env' });

  const itemsList = context.useMemo(
    (items) =>
      list(
        items,
        (item, index) =>
          block(Item, {
            title: item,
            onUp: () => {
              if (index > 0) {
                const newItems = items.slice();
                const tmp = newItems[index];
                newItems[index] = newItems[index - 1];
                newItems[index - 1] = tmp;
                setItems(newItems);
              }
            },
            onDown: () => {
              if (index + 1 < items.length) {
                const newItems = items.slice();
                const tmp = newItems[index];
                newItems[index] = newItems[index + 1];
                newItems[index + 1] = tmp;
                setItems(newItems);
              }
            },
            onDelete: () => {
              const newItems = items.slice();
              newItems.splice(index, 1);
              setItems(newItems);
            },
          }),
        (item) => item,
      ),
    [items],
  );

  const onIncrement = context.useEvent((_event) => {
    counterSignal.value += 1;
  });
  const onDecrement = context.useEvent((_event) => {
    counterSignal.value -= 1;
  });
  const onShuffle = context.useEvent((_event) => {
    const newItems = shuffle(items.slice());
    setItems(newItems);
  });

  return context.html`
        <div>
            ${block(Counter, {
              count: counterSignal.map((count) => count * 2),
            })}
            <ul>${itemsList}</ul>
            <p>
                <button type="button" onclick=${onIncrement}>+1</button>
                <button type="button" onclick=${onDecrement}>-1</button>
                <button type="button" onclick=${onShuffle}>Shuffle</button>
            </p>
        </div>
    `;
}

function Item(props, context) {
  const state = context.useEnv('state');

  return context.html`
        <li>
            <span>${props.title} (${state})</span>
            <button type="button" onclick=${context.useEvent(props.onUp)}>Up</button>
            <button type="button" onclick=${context.useEvent(props.onDown)}>Down</button>
            <button type="button" onclick=${context.useEvent(props.onDelete)}>Delete</button>
        </li>
    `;
}

function Counter(props, context) {
  const countLabelRef = context.useRef(null);

  return context.html`
        <h1>
            <span class="count-label" ref=${countLabelRef}>COUNT: </span>
            <span class="count-value" data-count=${props.count}>${props.count}</span>
        </h1>
    `;
}

function shuffle(array) {
  let currentIndex = array.length;

  while (currentIndex > 0) {
    const randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;
    const tmp = array[currentIndex];
    array[currentIndex] = array[randomIndex];
    array[randomIndex] = tmp;
  }

  return array;
}

if (typeof document === 'object') {
  boot(document.body, new Block(App, {}), new Context());
}
