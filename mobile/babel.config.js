module.exports = (api) => {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // O plugin de worklets precisa ser o último: é ele que transforma as
    // funções marcadas com 'worklet' — todo o pipeline de visão em src/scan —
    // em código que a thread do frame processor consegue executar.
    plugins: ['react-native-worklets/plugin'],
  };
};
