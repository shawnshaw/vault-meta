'use strict';

/** 核心能力统一出口（UI 与脚本共用，便于单独测试）。 */
module.exports = {
  errors: require('./errors'),
  paths: require('./paths'),
  fsUtils: require('./fs-utils'),
  tar: require('./tar'),
  archive: require('./archive'),
  spec: require('./component-spec'),
  registry: require('./registry'),
  projects: require('./projects'),
  identity: require('./identity'),
  gitMeta: require('./git-meta'),
  remote: require('./remote'),
  projectInspect: require('./project-inspect'),
  backup: require('./backup'),
  installer: require('./installer'),
  packager: require('./packager'),
  types: require('./types'),
};
