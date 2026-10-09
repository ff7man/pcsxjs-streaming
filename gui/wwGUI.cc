#include <emscripten.h>
#include <stdlib.h>
#include <SDL/SDL.h>
extern "C" {
#include "../plugins/sdlinput/pad.h"
void SetupSound(void);
}

unsigned char psxVub[2 * 1024 * 1024];
unsigned short *psxVuw;
static SDL_Surface *sdl_display;
static SDL_Surface *sdl_ximage;
SDL_Rect srcrect;
SDL_Rect dstrect;
int iDisStereo = 0;
void Blit32(uint32_t *dest_buf, int x, int y, int sx, int sy, int rgb24, int32_t lPitch)
{
  unsigned char *pD;
  unsigned int startxy;
  uint32_t lu, lr, lg, lb;
  unsigned short s;
  unsigned short row, column;

  uint32_t *destpix;

  if (rgb24)
  {
    for (column = 0; column < sy; column++)
    {
      startxy = ((1024) * (column + y)) + x;
      pD = &psxVub[startxy * 2];
      destpix = dest_buf + column * lPitch;
      for (row = 0; row < sx; row++)
      {
        lr = pD[0];
        lg = pD[1];
        lb = pD[2];
        destpix[row] = 0xff000000 | (lb << 16) | (lg << 8) | (lr);
        pD += 3;
      }
    }
  }
  else
  {
    //printf("blt 2\n");
    for (column = 0; column < sy; column++)
    {
      startxy = (1024 * (column + y)) + x;
      destpix = dest_buf + column * lPitch;
      for (row = 0; row < sx; row++)
      {
        s = psxVuw[startxy++];
        destpix[row] =
            (((s << 3) & 0xf8) | ((s << 6) & 0xf800) | ((s << 9) & 0xf80000)) | 0xff000000;
      }
    }
  }
}

void BlitSDL32(SDL_Surface *surface, int x, int y, int sx, int sy, int rgb24)
{
  EM_ASM_({ my_SDL_LockSurface($0); }, surface);
  Blit32((uint32_t *)surface->pixels, x, y, sx, sy, rgb24, surface->pitch >> 2);
  EM_ASM_({ my_SDL_UnlockSurface($0); }, surface);
}

extern "C" {
void render(int x, int y, int sx, int sy, int dx, int dy, int rgb24)
{
  BlitSDL32(sdl_ximage, x, y, sx, sy, rgb24);
  SDL_Flip(sdl_ximage);
  dstrect.x = 0;
  dstrect.y = 0;
  dstrect.w = 640;
  dstrect.h = 480;
  srcrect.x = 0;
  srcrect.y = 0;
  srcrect.w = dx;
  srcrect.h = dy;
  SDL_BlitScaled(sdl_ximage, &srcrect, sdl_display, &dstrect);
  SDL_Flip(sdl_display);
}
void *var_ptrs[] = {
    psxVub,
    &(g.PadState[0]),
    &(g.PadState[1])};
void *get_ptr(int i)
{
    return var_ptrs[i];
}

extern "C" void InitBrowserVideo(void)
{
  if (sdl_display != NULL)
    return;

  if (!SDL_WasInit(SDL_INIT_VIDEO) && SDL_InitSubSystem(SDL_INIT_VIDEO) < 0) {
    printf("(x) Failed to init browser video: %s\n", SDL_GetError());
    return;
  }

  sdl_display = SDL_SetVideoMode(640, 480, 32, SDL_HWSURFACE);
  sdl_ximage = SDL_CreateRGBSurface(SDL_HWSURFACE, 640, 480, 32,
                                    0x00ff0000, 0x0000ff00, 0x000000ff, 0);
}

extern "C" void InitBrowserAudio(void)
{
  SetupSound();
}
}
int main()
{
  psxVuw = (unsigned short *)psxVub;
  LoadPADConfig();
  EM_ASM(
      FS.mkdir('/cfg');
      FS.mount(IDBFS, {}, '/cfg/');

      // sync from persisted state into memory and then
      // run the 'test' function
      FS.syncfs(true, function(err) {
        if(err){
          cout_print("syncfs error!!")
        }
        assert(!err);
        _LoadPADConfig();
        cout_print("idbfs loaded\n");
      }););
  g.PadState[0].PadMode = 0;
  g.PadState[0].PadID = 0x41;
  g.PadState[1].PadMode = 0;
  g.PadState[1].PadID = 0x41;
  g.PadState[0].JoyKeyStatus = 0xFFFF;
  g.PadState[1].JoyKeyStatus = 0xFFFF;
  InitKeyboard();
  EM_ASM({ var_setup(); });
  emscripten_exit_with_live_runtime();
}
