import { mount } from '@geastack/core'
import { counter } from './store'
import './styles.css'

function App() {
  function increment() {
    const value = counter.increment()
    const count = document.querySelector('[data-count]')
    if (count) count.textContent = String(value)
  }

  return (
    <body class="app">
      <main class="panel">
        <p class="eyebrow">GeaStack</p>
        <h1>Counter</h1>
        <button class="button" onClick={increment}>
          Count <span data-count>0</span>
        </button>
      </main>
    </body>
  )
}

mount(App)
