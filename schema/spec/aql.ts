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
</schema> */

// <@ visibility="public">
export type AST = unknown;
// </@>

// <@ visibility="public">
export interface AQL {
//   <method-list>
//     <method note="CSS-like selectors for annotation nodes">
  select(selector: string): AnnotationNode[];
//     </method>

//     <method note="Unify against code inside annotations">
  match<T>(selector: string, pattern: (code: AST) => T | null): T[];
//     </method>

//     <method note="Find components that render a specific element">
  findComponentsRendering(elementName: string): AnnotationNode[];
//     </method>

//     <method note="Find where a prop value originates">
  traceSource(propName: string): SourceTrace[];
//     </method>

//     <method note="Check if component renders another">
  renders(component: string, target: string, opts: { depth: 'child' | 'descendant' }): boolean;
//     </method>

//     <method note="Get all components rendered by a component">
  renderedBy(component: string, opts: { depth: 'child' | 'descendant' }): string[];
//     </method>
//   </method-list>
}
// </@>

// <@ visibility="public">
export interface AnnotationNode {
//   <field-list>
    tag: string;
    attributes: Record<string, string | Expression>;
    children: AnnotationNode[];
//     <field note="the AST wrapped by this annotation">
    code: AST;
//     </field>
    parent: AnnotationNode | null;
//   </field-list>

//   <method-list>
//     <method note="find closest ancestor matching selector">
  closest(selector: string): AnnotationNode | null;
//     </method>

//     <method note="get all ancestor tags">
  ancestors(): string[];
//     </method>

//     <method note="select within this node's descendants">
  selectWithin(selector: string): AnnotationNode[];
//     </method>

//     <method note="next sibling, optionally matching selector">
  next(selector?: string): AnnotationNode | null;
//     </method>

//     <method note="get attribute value">
  attr(name: string): string | null;
//     </method>

//     <method note="resolve prolog expression with bindings from code">
  resolve(attrName: string): string;
//     </method>

//     <method note="get specific binding from code">
  binding(path: string): string;
//     </method>
//   </method-list>
}
// </@>

// <@ visibility="public">
export interface Expression {
//   <field-list>
    raw: string;
//     <field note="$1, $1.queryKey, etc resolved">
    bindings: Record<string, AST>;
//     </field>
//   </field-list>
}
// </@>

// <@ visibility="public">
export interface SourceTrace {
//   <field-list>
    prop: string;
    source: AST;
    annotation: AnnotationNode;
//   </field-list>
}
// </@>
