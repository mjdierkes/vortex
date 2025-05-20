'use client';

import { DynamicReactExample } from '@/components/DynamicReactExample';

const EXAMPLES = [
  {
    title: 'Basic Counter',
    description: 'A simple counter component with state management.',
    code: `
function Component() {
  const [count, setCount] = useState(0);
  
  return (
    <div className="p-4 border rounded">
      <h2 className="text-lg font-bold mb-2">Counter Example</h2>
      <p className="mb-4">Count: {count}</p>
      <button 
        className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        onClick={() => setCount(count + 1)}
      >
        Increment
      </button>
    </div>
  );
}`,
  },
  {
    title: 'Todo List',
    description: 'A more complex example with array state and multiple interactions.',
    code: `
function Component() {
  const [todos, setTodos] = useState([]);
  const [input, setInput] = useState('');

  const addTodo = () => {
    if (input.trim()) {
      setTodos([...todos, { id: Date.now(), text: input, done: false }]);
      setInput('');
    }
  };

  const toggleTodo = (id) => {
    setTodos(todos.map(todo => 
      todo.id === id ? { ...todo, done: !todo.done } : todo
    ));
  };

  return (
    <div className="p-4 border rounded">
      <h2 className="text-lg font-bold mb-4">Todo List</h2>
      
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && addTodo()}
          className="flex-1 px-3 py-2 border rounded"
          placeholder="Add a todo..."
        />
        <button 
          onClick={addTodo}
          className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600"
        >
          Add
        </button>
      </div>

      <ul className="space-y-2">
        {todos.map(todo => (
          <li 
            key={todo.id}
            className="flex items-center gap-2 p-2 border rounded"
          >
            <input
              type="checkbox"
              checked={todo.done}
              onChange={() => toggleTodo(todo.id)}
            />
            <span className={todo.done ? 'line-through text-gray-500' : ''}>
              {todo.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}`,
  },
];

export default function TestRenderPage() {
  return (
    <div className="container mx-auto py-8 px-4">
      <h1 className="text-3xl font-bold mb-8">Dynamic React Renderer Demo</h1>
      
      <div className="prose max-w-none mb-8">
        <p>
          This page demonstrates the DynamicReactRenderer component, which can render
          arbitrary React code at runtime. Edit the code in the text areas below to
          see live updates of the rendered components.
        </p>
      </div>

      <div className="grid gap-8">
        {EXAMPLES.map((example, index) => (
          <div key={index} className="border rounded-lg p-6 bg-white shadow-sm">
            <h2 className="text-2xl font-bold mb-2">{example.title}</h2>
            <p className="text-gray-600 mb-6">{example.description}</p>
            <DynamicReactExample key={index} defaultCode={example.code} />
          </div>
        ))}
      </div>
    </div>
  );
} 