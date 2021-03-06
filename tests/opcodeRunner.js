const fs = require('fs')
const tape = require('tape')
const Kernel = require('ewasm-kernel')
const wast2wasm = require('wast2wasm')
const Address = require('ewasm-kernel/deps/address.js')
const Block = require('ewasm-kernel/deps/block.js')
const blockchain = require('ewasm-kernel/fakeBlockChain')

const Message = require('ewasm-kernel/message.js')
const Vertex = require('merkle-trie')

const ethUtil = require('ethereumjs-util')
const compiler = require('../index.js')
const argv = require('minimist')(process.argv.slice(2))
const dir = `${__dirname}/opcode`

const WasmAgent = require('ewasm-kernel/wasmDebugAgent')
const codeHandler = require('ewasm-kernel/codeHandler')

codeHandler.handlers.wasm.init = (code) => {
  return new WasmAgent(code)
}

const setSP = `
(func (export "setSP") (param i32)
  (set_global $sp (get_local 0)))
`

// Transcompiled contracts have their EVM1 memory start at this WASM memory location
const EVM_MEMORY_OFFSET = 33832
let testFiles = fs.readdirSync(dir).filter((name) => name.endsWith('.json'))

// run a single file
if (argv.file) {
  testFiles = [argv.file]
}

tape('testing EVM1 Ops', async t => {
  for (const path of testFiles) {
    let opTest = require(`${dir}/${path}`)
    for (const test of opTest) {
      // FIXME: have separate `t.test()` for better grouping
      t.comment(`testing ${test.op} ${test.description}`)

      const [funcs, imports] = compiler.resolveFunctions(new Set([test.op]))
      funcs.push(setSP)
      imports.push('(import "ethereum" "useGas" (func $useGas (param i64)))')
      const linked = compiler.buildModule(funcs, imports, [test.op])
      const {
        buffer: wasm
      } = await wast2wasm(linked)

      const message = new Message()
      const block = new Block()
      const state = new Vertex()

      // populate the environment
      message.from = ['code', test.environment.caller]
      message.data = Buffer.from(test.environment.callData.slice(2), 'hex')
      message.gas = 1000000
      block.header.coinbase = new Address(test.environment.coinbase)

      state.set(['block'], new Vertex({
        value: block
      }))

      state.set(['blockchain'], new Vertex({
        value: blockchain
      }))

      const accountAddress = ['accounts', test.environment.address]
      state.set(accountAddress, new Vertex())
      const startingState = await state.get(accountAddress)

      const kernel = new Kernel({
        code: wasm,
        codeHandler: codeHandler,
        state: startingState
      })

      try {
        await kernel.recieve(message)
      } catch (e) {
        t.fail('WASM exception: ' + e)
        return
      }

      let testInstance = kernel._vm.instance
      // populate the stack with predefined values
      test.in.stack.forEach((item, index) => {
        item = hexToUint8Array(item).reverse()
        setMemory(testInstance, item, index * 32)
      })

      // populate the memory
      if (test.in.memory) {
        Object.keys(test.in.memory).forEach((offset) => {
          let item = test.in.memory[offset]
          offset |= 0
          offset += EVM_MEMORY_OFFSET
          item = hexToUint8Array(item).reverse()
          setMemory(testInstance, item, offset)
        })
      }

      // Runs the opcode. An empty stack must start with the stack pointer at -8.
      // also we have to add 8 to the resulting sp to accommodate for the fact
      // that the sp is pointing to memory segment holding the last stack item
      let sp = (test.in.stack.length - 1) * 32

      try {
        testInstance.exports.setSP(sp)
        testInstance.exports[test.op](...(test.params || []))
        await kernel._vm.onDone()
      } catch (e) {
        t.fail('WASM exception: ' + e)
      }

      if (isNaN(sp)) {
        t.fail('methods should return the stack pointer')
      }

      if (sp % 32) {
        t.fail('stack must be a multiple of 32 bytes')
      }

      sp = 0
      // compare the output stack against the predefined values
      test.out.stack.forEach((item, index) => {
        const expectedItem = hexToUint8Array(item)
        const result = getMemory(testInstance, sp, sp = sp + 32)
        t.equals(result.toString(), expectedItem.toString(), 'should have correct item on stack')
      })

      // check the memory
      if (test.out.memory) {
        Object.keys(test.out.memory).forEach((offset) => {
          offset |= 0
          const item = test.out.memory[offset]
          const expectedItem = hexToUint8Array(item)
          offset += EVM_MEMORY_OFFSET
          const result = getMemory(testInstance, offset, offset + expectedItem.length)
          t.equals(result.toString(), expectedItem.toString(), `should have the correct memory slot at ${offset}`)
        })
      }

      // check for EVM return value
      if (test.out.return) {
        const response = kernel._vm.responses.ethereum.returnValue
        const expectedItem = hexToUint8Array(test.out.return)
        t.equals(response.toString(), expectedItem.toString(), 'should have correct return value')
      }

      if (test.out.gasUsed) {
        t.equals(1000000 - message.gas, test.out.gasUsed, 'should have used the correct amount of gas')
      }
    }
  }
  t.end()
})

function hexToUint8Array (item, length) {
  return new Uint8Array(ethUtil.setLength(Buffer.from(item.slice(2), 'hex'), length || 32))
}

function setMemory (instance, value, start) {
  new Uint8Array(instance.exports.memory.buffer).set(value, start)
}

function getMemory (instance, start, end) {
  return new Uint8Array(instance.exports.memory.buffer).slice(start, end).reverse()
}
