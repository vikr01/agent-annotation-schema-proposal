/* <schema>
  <extends>
    <source name="XML/HTML" usage="Tag and attribute structure" />
    <source name="JSX" usage="Curly braces for expression context" />
    <source name="CSS Selectors" usage="Queryable by tag, id, attribute" />
    <source name="Prolog" usage="Unification variables, pattern matching" />
    <source name="Shell/Perl" usage="Positional arguments ($1, $2, ...)" />
  </extends>

  <def name="$N" desc="Nth argument of annotated call (1-indexed)" />
  <def name="$N.path" desc="Property access into argument" />
  <def name="$0" desc="Return value of annotated call" />
  <def name="{expr}" desc="Expression with unification, evaluated at query time" />
  <def name="attr='value'" desc="Static string" />
  <def name="<@>" desc="Wrapper for attributes on code that already declares its own type" />

  <group name="suspense" desc="React Suspense-related attributes">
    <attr name="boundary" desc="Suspense boundary requirement" />
    <attr name="preload" desc="Prefetch call to avoid waterfall" />
    <attr name="invalidate" desc="Cache invalidation call" />
    <attr name="invalidate-key" desc="Direct reference to cache key" />
  </group>

  <audience-list>
    <audience name="product" desc="Product engineers building features" />
    <audience name="infra" desc="Infrastructure team maintaining internals" />
  </audience-list>

  <visibility-list>
    <visibility name="public" desc="Stable API, safe to depend on" />
    <visibility name="internal" desc="Implementation detail, may change" />
  </visibility-list>
</schema> */

// <component id="TodoList" visibility="public">
//   <props>
//     <accepts type={React.ComponentProps<typeof TodoListView>} />
//     <omission-list>
//       <omission reason="fetched from API">
export type TodoListProps = Omit<React.ComponentProps<typeof TodoListView>,
  'items'
//       </omission>
  |
//       <omission reason="computed from fetch state">
  'isLoading'
//       </omission>
//     </omission-list>
//   </props>
>;

export function TodoList(props: TodoListProps): React.ReactNode {
//   <react-hook
//     suspends="true"
//     throws="false"
//     boundary="requires Suspense ancestor"
//     preload={queryClient.prefetchQuery($1)}
//     invalidate={queryClient.invalidateQueries({ queryKey: $1.queryKey })}
//     invalidate-key={$1.queryKey}
//   >
  const { data } = useSuspenseQuery({
//     <field-list>
//       <field audience="product" note="include all params that affect response">
    queryKey: ['todos', props.userId],
//       </field>
//       <field audience="product" note="errors trigger nearest ErrorBoundary">
    queryFn: () => fetchTodos(props.userId),
//       </field>
//     </field-list>
  });
//   </react-hook>

//   <branch condition={props.filter === 'completed'}>
  if (props.filter === 'completed') {
//     <perf-critical owner="@platform" audience="infra" visibility="internal">
    const sorted = sortByCompletedDate(data);
//     </perf-critical>
//     <render>
    return (
      <TodoListView
//       <prop-list>
//         <prop spread={props} />
        {...props}
//         <prop name="items" source={sorted}>
        items={sorted}
//         </prop>
//         <prop name="isLoading" value={false}>
        isLoading={false}
//         </prop>
//       </prop-list>
      />
    );
//     </render>
  }
//   </branch>

//   <render>
  return (
    <TodoListView
//     <prop-list>
//       <prop spread={props} />
      {...props}
//       <prop name="items" source={data}>
      items={data}
//       </prop>
//       <prop name="isLoading" value={false}>
      isLoading={false}
//       </prop>
//     </prop-list>
    />
  );
//   </render>
}
// </component>

type Todo = { id: string; title: string; completed: boolean; completedAt?: Date };
declare function TodoListView(props: { items: Todo[]; isLoading: boolean; userId?: string; filter?: string }): React.ReactNode;
declare function useSuspenseQuery<T>(opts: { queryKey: unknown[]; queryFn: () => T }): { data: T };
declare function fetchTodos(userId: string | undefined): Todo[];
declare function sortByCompletedDate(todos: Todo[]): Todo[];
