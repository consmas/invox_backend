import type { NextConfig } from 'next';
const config: NextConfig = {
  output:'standalone',
  distDir:process.env.NEXT_DIST_DIR||'.next',
  outputFileTracingRoot:process.cwd(),
  async rewrites(){return [
    {source:'/users/sign_in',destination:'/api/auth/login'},
    {source:'/users/sign_out',destination:'/api/auth/logout'},
    {source:'/users/me',destination:'/api/auth/me'},
    {source:'/users/password',destination:'/api/auth/password'},
    {source:'/up',destination:'/api/health'},
  ];},
};
export default config;
