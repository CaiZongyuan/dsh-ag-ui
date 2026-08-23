export const DOJO_FEATURES = [
  'agentic_chat',
  'backend_tool_rendering',
  'shared_state',
  'human_in_the_loop',
  'tool_based_generative_ui',
]

export const FEATURE_CONTEXT_NAME = 'DSH Dojo Feature'
export const FEATURE_INSTRUCTIONS = {
  agentic_chat: 'Reply conversationally. Do not call get_weather unless the user explicitly asks for weather.',
  backend_tool_rendering: 'Use get_weather for weather questions and summarize its result.',
  shared_state: 'Read Current Shared State and use ag_ui_update_state for requested state changes.',
  human_in_the_loop: 'Use the client-provided generate_task_steps Tool and wait for the browser result.',
  tool_based_generative_ui: 'Use the client-provided generate_haiku Tool for haiku requests.',
}
export const DOJO_TENANT_ID = 'dojo'
export const DOJO_SHARED_SECRET = process.env.DSH_AG_UI_SHARED_SECRET
if (!DOJO_SHARED_SECRET) throw new Error('DSH_AG_UI_SHARED_SECRET is required before loading the Dojo host.')

export const WEATHER_RESULT = {
  temperature: 20,
  conditions: 'sunny',
  humidity: 50,
  windSpeed: 10,
  feelsLike: 25,
}
