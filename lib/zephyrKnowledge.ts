// Curated Zephyr fault knowledge. Injected as grounding context so the
// diagnoser reasons from documented Zephyr behavior, not invented APIs.
// Keep entries short and factual; each maps a signature -> cause -> fix levers.

export interface KnowledgeEntry {
  signature: string;
  likelyCauses: string[];
  fixLevers: string[]; // Kconfig symbols / devicetree / code patterns
  docs: string;
}

export const ZEPHYR_KNOWLEDGE: KnowledgeEntry[] = [
  {
    signature: "Stack overflow (K_ERR_STACK_CHK_FAIL, reason 2) / MPU FAULT with stacking error",
    likelyCauses: [
      "Thread stack too small for its call depth or local buffers",
      "Deep recursion or large stack-allocated arrays",
      "printf/logging from a thread with a tight stack",
      "ISR using a small system/IRQ stack",
    ],
    fixLevers: [
      "Increase the offending thread's stack: K_THREAD_STACK_DEFINE size, or CONFIG_MAIN_STACK_SIZE",
      "CONFIG_IDLE_STACK_SIZE, CONFIG_ISR_STACK_SIZE, CONFIG_SYSTEM_WORKQUEUE_STACK_SIZE as relevant",
      "Enable CONFIG_THREAD_STACK_INFO + CONFIG_THREAD_ANALYZER to measure real usage",
      "Move large buffers off the stack (static/heap)",
    ],
    docs: "Zephyr: Kernel > Threads (stack sizing); CONFIG_THREAD_ANALYZER",
  },
  {
    signature: "USAGE FAULT — Illegal use of the EPSR / Attempt to execute undefined instruction / Unaligned access",
    likelyCauses: [
      "Calling through a corrupted/NULL function pointer (PC points to non-code)",
      "Returning to a bad LR after stack corruption",
      "Unaligned access with CONFIG_TRAP_UNALIGNED_ACCESS, or division by zero",
    ],
    fixLevers: [
      "Use the faulting PC to locate the instruction: addr2line -e build/zephyr/zephyr.elf <pc>",
      "Check for NULL/uninitialized callbacks and corrupted function pointers",
      "Build with CONFIG_DEBUG_THREAD_INFO / lower optimization (CONFIG_NO_OPTIMIZATIONS) to symbolize",
    ],
    docs: "Zephyr: Debugging > Fatal errors; ARM Cortex-M fault handling",
  },
  {
    signature: "BUS FAULT / Data access violation / Precise data bus error (BFAR set)",
    likelyCauses: [
      "Dereferencing an invalid/NULL pointer (BFAR shows the bad address)",
      "Accessing a peripheral whose clock/power domain is not enabled",
      "DMA to an address outside RAM",
    ],
    fixLevers: [
      "Read BFAR/CFSR to get the offending address and compare against the SoC memory map (datasheet)",
      "Verify the peripheral clock is enabled in devicetree (status = \"okay\") and pinctrl is applied",
      "Confirm DMA buffers live in valid, cache-coherent RAM regions",
    ],
    docs: "Zephyr: Device Driver Model; SoC reference manual memory map & RCC/clock control",
  },
  {
    signature: "Kernel oops (reason 3) / Kernel panic (reason 4)",
    likelyCauses: [
      "k_oops()/k_panic() reached, or __ASSERT firing in kernel code",
      "Calling a blocking API from ISR context (k_is_in_isr())",
      "Mutex/semaphore misuse, or scheduling from an invalid context",
    ],
    fixLevers: [
      "Inspect the assertion expression and file:line to find the violated invariant",
      "Do not call k_sleep / blocking k_sem_take / mutex ops from an ISR; defer with k_work",
      "Enable CONFIG_ASSERT and CONFIG_ASSERT_VERBOSE for clearer messages",
    ],
    docs: "Zephyr: Kernel Services > Synchronization; Interrupts (ISR restrictions)",
  },
  {
    signature: "Spurious / unhandled interrupt (reason 1)",
    likelyCauses: [
      "An IRQ fires with no ISR connected (IRQ_CONNECT missing or wrong IRQ number)",
      "Peripheral enabled in devicetree but driver/CONFIG not enabled",
      "NVIC priority/grouping misconfiguration",
    ],
    fixLevers: [
      "Confirm IRQ_CONNECT()/irq_enable() for the peripheral, matching the datasheet IRQ number",
      "Enable the matching driver Kconfig (e.g. CONFIG_UART_INTERRUPT_DRIVEN)",
      "Check devicetree interrupts property against the SoC vector table",
    ],
    docs: "Zephyr: Interrupts; SoC reference manual interrupt/NVIC table",
  },
  {
    signature: "Log messages dropped / <wrn> only, no fatal fault",
    likelyCauses: [
      "Log backend can't keep up (buffer too small) or runtime filtering hides detail",
      "A non-fatal misconfiguration the device tolerated but reported",
    ],
    fixLevers: [
      "Increase CONFIG_LOG_BUFFER_SIZE; consider CONFIG_LOG_MODE_IMMEDIATE for ordering during debug",
      "Raise log level (CONFIG_LOG_DEFAULT_LEVEL) to capture the missing context",
    ],
    docs: "Zephyr: Logging subsystem",
  },
];

export function knowledgeContext(entries: KnowledgeEntry[] = ZEPHYR_KNOWLEDGE): string {
  return entries
    .map(
      (k) =>
        `### ${k.signature}\n` +
        `Likely causes: ${k.likelyCauses.join("; ")}\n` +
        `Fix levers: ${k.fixLevers.join("; ")}\n` +
        `Reference: ${k.docs}`
    )
    .join("\n\n");
}

// Pick only the knowledge entries relevant to the parsed fault, to keep the
// grounding block small. Falls back to all entries if nothing matches.
export function selectKnowledge(descriptor: string): KnowledgeEntry[] {
  const d = (descriptor || "").toLowerCase();
  if (!d.trim()) return ZEPHYR_KNOWLEDGE;
  const tokens = d.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const scored = ZEPHYR_KNOWLEDGE.map((k) => {
    const sig = k.signature.toLowerCase();
    let score = 0;
    for (const t of tokens) if (sig.includes(t)) score++;
    return { k, score };
  });
  const hits = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  if (!hits.length) return ZEPHYR_KNOWLEDGE;
  return hits.slice(0, 3).map((s) => s.k);
}
