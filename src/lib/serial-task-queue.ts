export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve()
  private pending = 0

  run<T>(task: () => Promise<T>): Promise<T> {
    this.pending++
    const result = this.tail.then(task, task)
    this.tail = result.then(
      () => { this.pending-- },
      () => { this.pending-- },
    )
    return result
  }

  async drain(): Promise<void> {
    await this.tail
  }

  get size(): number {
    return this.pending
  }
}
