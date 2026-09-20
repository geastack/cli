import { ReactiveComponent } from '@geastack/core'
import './styles.css'

export class App extends ReactiveComponent {
  count = 0

  decrement() {
    this.count = this.count - 1
  }

  increment() {
    this.count = this.count + 1
  }

  template() {
    return (
      <div class="screen">
        <span class="eyebrow">GEASTACK</span>
        <span class="title">Component state</span>
        <span class="count">{this.count}</span>
        <div class="controls">
          <button class="button secondary" onClick={() => this.decrement()}>−</button>
          <button class="button primary" onClick={() => this.increment()}>+</button>
        </div>
      </div>
    )
  }
}
