export type TodoListProps = Omit<
  React.ComponentProps<typeof TodoListView>,
  "items" | "isLoading"
>;

export function TodoList(props: TodoListProps): React.ReactNode {
  const { data } = useSuspenseQuery({
    queryKey: ["todos", props.userId],
    queryFn: () => fetchTodos(props.userId),
  });

  if (props.filter === "completed") {
    const sorted = sortByCompletedDate(data);
    return <TodoListView {...props} items={sorted} isLoading={false} />;
  }

  return <TodoListView {...props} items={data} isLoading={false} />;
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
  userId?: string;
  filter?: string;
}): React.ReactNode;
declare function useSuspenseQuery<T>(opts: {
  queryKey: unknown[];
  queryFn: () => T;
}): { data: T };
declare function fetchTodos(userId: string | undefined): Todo[];
declare function sortByCompletedDate(todos: Todo[]): Todo[];
