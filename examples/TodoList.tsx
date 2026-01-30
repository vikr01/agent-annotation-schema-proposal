export type TodoListProps = {
  userId: string;
  filter?: "all" | "completed";
};

export function TodoList({ userId, filter }: TodoListProps): React.ReactNode {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchTodos(userId).then((data) => {
      setTodos(data);
      setIsLoading(false);
    });
  }, [userId]);

  if (filter === "completed") {
    const sorted = sortByCompletedDate(todos);
    return <TodoListView items={sorted} isLoading={false} />;
  }

  return <TodoListView items={todos} isLoading={isLoading} />;
}

type Todo = {
  id: string;
  title: string;
  completed: boolean;
  completedAt?: Date;
};
declare function TodoListView(props: {
  items: Todo[];
  isLoading: boolean;
}): React.ReactNode;
declare function useState<T>(initial: T): [T, (v: T) => void];
declare function useEffect(effect: () => void, deps: unknown[]): void;
declare function fetchTodos(userId: string): Promise<Todo[]>;
declare function sortByCompletedDate(todos: Todo[]): Todo[];
