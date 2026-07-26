import { expect } from 'bun:test'

// bun:test types `expect(promise).rejects` as returning void, which makes an
// awaited assertion look like a mistake. Assert on the caught error instead.
export const expectRejection = async (promise: Promise<unknown>, message: string | RegExp) => {
  let caught: unknown
  await promise.catch((error) => {
    caught = error
  })
  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).message).toMatch(message)
}
