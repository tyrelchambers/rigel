/**
 * Placeholder for a credential the server reports as stored. A stored secret is
 * never sent back, so the input is empty either way and only this tells "set"
 * apart from "never configured". It is a placeholder, never a value: the field
 * stays empty until the user types, and an untouched field is still omitted
 * from the patch.
 */
export const SECRET_MASK = "************";
