import { type Todo } from "../../shared/todos.js";
import styles from "./TodoList.module.css";

const labels = {
  pending: { mark: "○", text: "未着手" },
  in_progress: { mark: "◐", text: "進行中" },
  completed: { mark: "✓", text: "完了" },
};
export function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <section className={styles.list} aria-label="進捗リスト">
      <b>
        進捗 · {todos.filter((t) => t.status === "completed").length}/
        {todos.length} 完了
      </b>
      {!todos.length && <p>進捗リストは空です</p>}
      <ul>
        {todos.map((todo, index) => (
          <li key={index} data-status={todo.status}>
            <span className={styles.status}>
              {labels[todo.status].mark} {labels[todo.status].text}
            </span>
            <span className={styles.content}>{todo.content}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
