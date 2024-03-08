import {
  Binding,
  Directive,
  Part,
  createBinding,
  directiveTag,
  updateBinding,
} from '../part.js';
import type { Updater } from '../updater.js';
import { NullDirective } from './null.js';

type ValueOrFunction<T> = T extends Function ? never : T | (() => T);

export function condition<TTrue, TFalse>(
  condition: ValueOrFunction<boolean>,
  trueCase: ValueOrFunction<TTrue>,
  falseCase: ValueOrFunction<TFalse>,
): ConditionDirective<TTrue, TFalse> {
  return new ConditionDirective(condition, trueCase, falseCase);
}

export function when<TTrue>(
  condition: ValueOrFunction<boolean>,
  trueCase: ValueOrFunction<TTrue>,
): ConditionDirective<TTrue, NullDirective> {
  return new ConditionDirective(condition, trueCase, new NullDirective());
}

export function unless<TFalse>(
  condition: ValueOrFunction<boolean>,
  falseCase: ValueOrFunction<TFalse>,
): ConditionDirective<NullDirective, TFalse> {
  return new ConditionDirective(condition, new NullDirective(), falseCase);
}

export class ConditionDirective<TTrue, TFalse>
  implements Directive<ConditionDirective<TTrue, TFalse>>
{
  private readonly _condition: ValueOrFunction<boolean>;

  private readonly _trueCase: ValueOrFunction<TTrue>;

  private readonly _falseCase: ValueOrFunction<TFalse>;

  constructor(
    condition: ValueOrFunction<boolean>,
    trueCase: ValueOrFunction<TTrue>,
    falseCase: ValueOrFunction<TFalse>,
  ) {
    this._condition = condition;
    this._trueCase = trueCase;
    this._falseCase = falseCase;
  }

  get condition(): ValueOrFunction<boolean> {
    return this._condition;
  }

  get trueCase(): ValueOrFunction<TTrue> {
    return this._trueCase;
  }

  get falseCase(): ValueOrFunction<TFalse> {
    return this._falseCase;
  }

  [directiveTag](
    part: Part,
    updater: Updater,
  ): ConditionBinding<TTrue, TFalse> {
    const binding = new ConditionBinding<TTrue, TFalse>(part, this);

    binding.bind(updater);

    return binding;
  }

  valueOf(): this {
    return this;
  }
}

export class ConditionBinding<TTrue, TFalse>
  implements Binding<ConditionDirective<TTrue, TFalse>>
{
  private readonly _part: Part;

  private _directive: ConditionDirective<TTrue, TFalse>;

  private _trueBinding: Binding<TTrue> | null = null;

  private _falseBinding: Binding<TFalse> | null = null;

  constructor(part: Part, directive: ConditionDirective<TTrue, TFalse>) {
    this._part = part;
    this._directive = directive;
  }

  get part(): Part {
    return this._part;
  }

  get startNode(): ChildNode {
    const binding = this._directive.condition
      ? this._trueBinding
      : this._falseBinding;
    return binding?.startNode ?? this._part.node;
  }

  get endNode(): ChildNode {
    return this._part.node;
  }

  get value(): ConditionDirective<TTrue, TFalse> {
    return this._directive;
  }

  set value(newDirective: ConditionDirective<TTrue, TFalse>) {
    this._directive = newDirective;
  }

  bind(updater: Updater): void {
    const { condition, trueCase, falseCase } = this._directive;

    if (typeof condition === 'function' ? condition() : condition) {
      const newValue = typeof trueCase === 'function' ? trueCase() : trueCase;
      this._falseBinding?.unbind(updater);
      if (this._trueBinding !== null) {
        this._trueBinding = updateBinding(this._trueBinding, newValue, updater);
      } else {
        this._trueBinding = createBinding(this._part, newValue, updater);
      }
    } else {
      const newValue =
        typeof falseCase === 'function' ? falseCase() : falseCase;
      this._trueBinding?.unbind(updater);
      if (this._falseBinding !== null) {
        this._falseBinding = updateBinding(
          this._falseBinding,
          newValue,
          updater,
        );
      } else {
        this._falseBinding = createBinding(this._part, newValue, updater);
      }
    }
  }

  unbind(updater: Updater): void {
    const { condition } = this._directive;

    if (condition) {
      this._trueBinding?.unbind(updater);
      this._falseBinding?.disconnect();
    } else {
      this._falseBinding?.unbind(updater);
      this._trueBinding?.disconnect();
    }
  }

  disconnect(): void {
    this._trueBinding?.disconnect();
    this._falseBinding?.disconnect();
  }
}