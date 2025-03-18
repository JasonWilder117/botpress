import type {
  MessageHandlersMap as BotMessageHandlersMap,
  EventHandlersMap as BotEventHandlersMap,
  StateExpiredHandlersMap as BotStateExpiredHandlersMap,
  HookHandlersMap as BotHookHandlersMap,
  ActionHandlers as BotActionHandlers,
  BotHandlers,
  BotSpecificClient,
  WorkflowHandlersMap as BotWorkflowHandlersMap,
  WorkflowHandlers as BotWorkflowHandlers,
  WorkflowHandlersFnMap as BotWorkflowHandlersFnMap,
  WorkflowUpdateTypeSnakeCase as BotWorkflowUpdateTypeSnakeCase,
  WorkflowUpdateTypeCamelCase as BotWorkflowUpdateTypeCamelCase,
} from '../bot'
import { camelCaseUpdateTypeToSnakeCase } from '../bot/server/workflows/update-type-conv'
import { WorkflowProxy, proxyWorkflows } from '../bot/workflow-proxy'
import * as utils from '../utils'
import type * as typeUtils from '../utils/type-utils'
import { ActionProxy, proxyActions } from './action-proxy'
import { BasePlugin, PluginInterfaceExtensions } from './common'
import { formatEventRef, parseEventRef, resolveEvent } from './interface-resolution'
import {
  MessageHandlersMap,
  MessageHandlers,
  EventHandlersMap,
  EventHandlers,
  StateExpiredHandlersMap,
  StateExpiredHandlers,
  HookHandlersMap,
  HookData,
  HookHandlers,
  ActionHandlers,
  MessagePayloads,
  PluginConfiguration,
  StateExpiredPayloads,
  ActionHandlerPayloads,
  EventPayloads,
} from './server/types'

export type PluginImplementationProps<TPlugin extends BasePlugin = BasePlugin> = {
  actions: ActionHandlers<TPlugin>
}

export type PluginRuntimeProps<TPlugin extends BasePlugin = BasePlugin> = {
  alias?: string
  configuration: PluginConfiguration<TPlugin>
  interfaces: PluginInterfaceExtensions<TPlugin>
}

type Tools<TPlugin extends BasePlugin = BasePlugin> = {
  configuration: PluginConfiguration<TPlugin>
  interfaces: PluginInterfaceExtensions<TPlugin>
  actions: ActionProxy<TPlugin>
  workflows: WorkflowProxy<TPlugin>
  alias?: string
}

export class PluginImplementation<TPlugin extends BasePlugin = BasePlugin> implements BotHandlers<TPlugin> {
  private _runtimeProps: PluginRuntimeProps<TPlugin> | undefined

  private _actionHandlers: ActionHandlers<any>
  private _messageHandlers: MessageHandlersMap<any> = {}
  private _eventHandlers: EventHandlersMap<any> = {}
  private _stateExpiredHandlers: StateExpiredHandlersMap<any> = {}
  private _hookHandlers: HookHandlersMap<any> = {
    before_incoming_event: {},
    before_incoming_message: {},
    before_outgoing_message: {},
    before_outgoing_call_action: {},
    after_incoming_event: {},
    after_incoming_message: {},
    after_outgoing_message: {},
    after_outgoing_call_action: {},
  }
  private _workflowHandlers: BotWorkflowHandlersMap<TPlugin> = {}

  public constructor(public readonly props: PluginImplementationProps<TPlugin>) {
    this._actionHandlers = props.actions
  }

  public initialize(props: PluginRuntimeProps<TPlugin>): this {
    this._runtimeProps = props
    return this
  }

  private get _runtime() {
    if (!this._runtimeProps) {
      throw new Error(
        'Plugin not correctly initialized. This is likely because you access your plugin config outside of an handler.'
      )
    }
    return this._runtimeProps
  }

  private _getTools(client: BotSpecificClient<any>): Tools {
    const { configuration, interfaces, alias } = this._runtime
    const actions = proxyActions(client, interfaces) as ActionProxy<BasePlugin>
    const workflows = proxyWorkflows(client) as WorkflowProxy<BasePlugin>

    return {
      configuration,
      interfaces,
      actions,
      alias,
      workflows,
    }
  }

  public get actionHandlers(): BotActionHandlers<TPlugin> {
    return new Proxy(
      {},
      {
        get: (_, prop: string) => {
          prop = this._stripAliasPrefix(prop)
          const handler = this._actionHandlers[prop]
          if (!handler) {
            return undefined
          }
          return utils.functions.setName(
            (input: ActionHandlerPayloads<any>[string]) => handler({ ...input, ...this._getTools(input.client) }),
            handler.name
          )
        },
      }
    ) as BotActionHandlers<TPlugin>
  }

  public get messageHandlers(): BotMessageHandlersMap<TPlugin> {
    return new Proxy(
      {},
      {
        get: (_, prop: string) => {
          prop = this._stripAliasPrefix(prop)
          const specificHandlers = this._messageHandlers[prop] ?? []
          const globalHandlers = this._messageHandlers['*'] ?? []
          const allHandlers = utils.arrays.unique([...specificHandlers, ...globalHandlers])
          return allHandlers.map((handler) =>
            utils.functions.setName(
              (input: MessagePayloads<any>[string]) => handler({ ...input, ...this._getTools(input.client) }),
              handler.name
            )
          )
        },
      }
    ) as BotMessageHandlersMap<TPlugin>
  }

  public get eventHandlers(): BotEventHandlersMap<TPlugin> {
    return new Proxy(
      {},
      {
        get: (_, prop: string) => {
          prop = this._stripAliasPrefix(prop)

          // if prop is "github:prOpened", include both "github:prOpened" and "creatable:itemCreated"

          const specificHandlers = this._eventHandlers[prop] ?? []

          const interfaceHandlers = Object.entries(this._eventHandlers)
            .filter(([e]) => this._eventResolvesTo(e, prop))
            .flatMap(([, handlers]) => handlers ?? [])

          const globalHandlers = this._eventHandlers['*'] ?? []
          const allHandlers = utils.arrays.unique([...specificHandlers, ...interfaceHandlers, ...globalHandlers])

          return allHandlers.map((handler) =>
            utils.functions.setName(
              (input: EventPayloads<any>[string]) => handler({ ...input, ...this._getTools(input.client) }),
              handler.name
            )
          )
        },
      }
    ) as BotEventHandlersMap<TPlugin>
  }

  public get stateExpiredHandlers(): BotStateExpiredHandlersMap<TPlugin> {
    return new Proxy(
      {},
      {
        get: (_, prop: string) => {
          prop = this._stripAliasPrefix(prop)

          const specificHandlers = this._stateExpiredHandlers[prop] ?? []
          const globalHandlers = this._stateExpiredHandlers['*'] ?? []
          const allHandlers = utils.arrays.unique([...specificHandlers, ...globalHandlers])
          return allHandlers.map((handler) =>
            utils.functions.setName(
              (input: StateExpiredPayloads<any>[string]) => handler({ ...input, ...this._getTools(input.client) }),
              handler.name
            )
          )
        },
      }
    ) as BotStateExpiredHandlersMap<TPlugin>
  }

  public get hookHandlers(): BotHookHandlersMap<TPlugin> {
    return new Proxy(
      {},
      {
        get: (_, hookType: keyof HookHandlersMap<TPlugin>) => {
          const hooks = this._hookHandlers[hookType]
          if (!hooks) {
            return undefined
          }
          return new Proxy(
            {},
            {
              get: (_, prop: string) => {
                prop = this._stripAliasPrefix(prop)

                const specificHandlers = hooks[prop] ?? []

                // for "before_incoming_event", "after_incoming_event" and other event related hooks
                const interfaceHandlers = Object.entries(hooks as Record<string, Function[]>) // TODO: fix typing here
                  .filter(([e]) => this._eventResolvesTo(e, prop))
                  .flatMap(([, handlers]) => handlers ?? [])

                const globalHandlers = hooks['*'] ?? []
                const handlers = utils.arrays.unique([...specificHandlers, ...interfaceHandlers, ...globalHandlers])

                return handlers.map((handler) =>
                  utils.functions.setName(
                    (input: any) => handler({ ...input, ...this._getTools(input.client) }),
                    handler.name
                  )
                )
              },
            }
          )
        },
      }
    ) as BotHookHandlersMap<TPlugin>
  }

  public get workflowHandlers(): BotWorkflowHandlersMap<TPlugin> {
    return new Proxy(
      {},
      {
        get: (_, updateType: BotWorkflowUpdateTypeSnakeCase) => {
          return new Proxy(
            {},
            {
              get: (_, workflowName: typeUtils.StringKeys<TPlugin['workflows']>) => {
                const handlersOfType = this._workflowHandlers[updateType]
                const selfHandlers = handlersOfType?.[workflowName]

                return (selfHandlers ?? []).map((handler) =>
                  utils.functions.setName(
                    (input: any) => handler({ ...input, ...this._getTools(input.client) }),
                    handler.name
                  )
                )
              },
            }
          )
        },
      }
    )
  }

  public readonly on = {
    message: <T extends keyof MessageHandlersMap<TPlugin>>(type: T, handler: MessageHandlers<TPlugin>[T]): void => {
      this._messageHandlers[type as string] = utils.arrays.safePush(
        this._messageHandlers[type as string],
        handler as MessageHandlers<any>[string]
      )
    },

    /**
     * # EXPERIMENTAL
     * This API is experimental and may change in the future.
     */
    workflows: new Proxy(
      {},
      {
        get: <TWorkflowName extends typeUtils.StringKeys<TPlugin['workflows']>>(
          _: unknown,
          workflowName: TWorkflowName
        ) =>
          new Proxy(
            {},
            {
              get: (_, updateType: BotWorkflowUpdateTypeCamelCase) => {
                if (updateType !== 'started' && updateType !== 'continued' && updateType !== 'timedOut') {
                  updateType satisfies never
                }

                return (handler: BotWorkflowHandlers<TPlugin>[TWorkflowName]): void => {
                  const updateTypeSnakeCase = camelCaseUpdateTypeToSnakeCase(updateType)
                  this._workflowHandlers[updateTypeSnakeCase] ??= {}
                  this._workflowHandlers[updateTypeSnakeCase][workflowName] = utils.arrays.safePush(
                    this._workflowHandlers[updateTypeSnakeCase][workflowName],
                    handler
                  )
                }
              },
            }
          ),
      }
    ) as BotWorkflowHandlersFnMap<TPlugin, Tools<TPlugin>>,

    event: <T extends keyof EventHandlersMap<TPlugin>>(type: T, handler: EventHandlers<TPlugin>[T]): void => {
      this._eventHandlers[type as string] = utils.arrays.safePush(
        this._eventHandlers[type as string],
        handler as EventHandlers<any>[string]
      )
    },

    stateExpired: <T extends keyof StateExpiredHandlersMap<TPlugin>>(
      type: T,
      handler: StateExpiredHandlers<TPlugin>[T]
    ): void => {
      this._stateExpiredHandlers[type as string] = utils.arrays.safePush(
        this._stateExpiredHandlers[type as string],
        handler as StateExpiredHandlers<any>[string]
      )
    },

    beforeIncomingEvent: <T extends keyof HookData<TPlugin>['before_incoming_event']>(
      type: T,
      handler: HookHandlers<TPlugin>['before_incoming_event'][T]
    ) => {
      this._hookHandlers.before_incoming_event[type as string] = utils.arrays.safePush(
        this._hookHandlers.before_incoming_event[type as string],
        handler as HookHandlers<any>['before_incoming_event'][string]
      )
    },

    beforeIncomingMessage: <T extends keyof HookData<TPlugin>['before_incoming_message']>(
      type: T,
      handler: HookHandlers<TPlugin>['before_incoming_message'][T]
    ) => {
      this._hookHandlers.before_incoming_message[type as string] = utils.arrays.safePush(
        this._hookHandlers.before_incoming_message[type as string],
        handler as HookHandlers<any>['before_incoming_message'][string]
      )
    },

    beforeOutgoingMessage: <T extends keyof HookData<TPlugin>['before_outgoing_message']>(
      type: T,
      handler: HookHandlers<TPlugin>['before_outgoing_message'][T]
    ) => {
      this._hookHandlers.before_outgoing_message[type as string] = utils.arrays.safePush(
        this._hookHandlers.before_outgoing_message[type as string],
        handler as HookHandlers<any>['before_outgoing_message'][string]
      )
    },

    beforeOutgoingCallAction: <T extends keyof HookData<TPlugin>['before_outgoing_call_action']>(
      type: T,
      handler: HookHandlers<TPlugin>['before_outgoing_call_action'][T]
    ) => {
      this._hookHandlers.before_outgoing_call_action[type as string] = utils.arrays.safePush(
        this._hookHandlers.before_outgoing_call_action[type as string],
        handler as HookHandlers<any>['before_outgoing_call_action'][string]
      )
    },

    afterIncomingEvent: <T extends keyof HookData<TPlugin>['after_incoming_event']>(
      type: T,
      handler: HookHandlers<TPlugin>['after_incoming_event'][T]
    ) => {
      this._hookHandlers.after_incoming_event[type as string] = utils.arrays.safePush(
        this._hookHandlers.after_incoming_event[type as string],
        handler as HookHandlers<any>['after_incoming_event'][string]
      )
    },

    afterIncomingMessage: <T extends keyof HookData<TPlugin>['after_incoming_message']>(
      type: T,
      handler: HookHandlers<TPlugin>['after_incoming_message'][T]
    ) => {
      this._hookHandlers.after_incoming_message[type as string] = utils.arrays.safePush(
        this._hookHandlers.after_incoming_message[type as string],
        handler as HookHandlers<any>['after_incoming_message'][string]
      )
    },

    afterOutgoingMessage: <T extends keyof HookData<TPlugin>['after_outgoing_message']>(
      type: T,
      handler: HookHandlers<TPlugin>['after_outgoing_message'][T]
    ) => {
      this._hookHandlers.after_outgoing_message[type as string] = utils.arrays.safePush(
        this._hookHandlers.after_outgoing_message[type as string],
        handler as HookHandlers<any>['after_outgoing_message'][string]
      )
    },

    afterOutgoingCallAction: <T extends keyof HookData<TPlugin>['after_outgoing_call_action']>(
      type: T,
      handler: HookHandlers<TPlugin>['after_outgoing_call_action'][T]
    ) => {
      this._hookHandlers.after_outgoing_call_action[type as string] = utils.arrays.safePush(
        this._hookHandlers.after_outgoing_call_action[type as string],
        handler as HookHandlers<any>['after_outgoing_call_action'][string]
      )
    },
  }

  /**
   * checks if the actual event resolves to the target event
   */
  private _eventResolvesTo = (actualEventRef: string, targetEventRef: string) => {
    const parsedRef = parseEventRef(actualEventRef)
    if (!parsedRef) {
      return false
    }
    const resolvedRef = resolveEvent(parsedRef, this._runtime.interfaces)
    const formattedRef = formatEventRef(resolvedRef)
    return formattedRef === targetEventRef
  }

  private _stripAliasPrefix = (prop: string) => {
    const { alias } = this._runtime
    if (!alias) {
      return prop
    }
    const prefix = `${alias}:`
    return prop.startsWith(prefix) ? prop.slice(prefix.length) : prop
  }
}
