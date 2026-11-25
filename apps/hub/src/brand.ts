/**
 * A primitive tagged with the domain concept it stands for, so two different
 * identifiers can't be swapped by accident (coding standards: TypeScript).
 */
export type Brand<T, Name extends string> = T & { readonly __brand: Name };
