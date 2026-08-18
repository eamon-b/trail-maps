import {
  assetToSelectedPhoto,
  hasComposerContent,
  pickPhotoContentType,
  selectedPhotoFromResult,
} from '../photo-upload';

describe('pickPhotoContentType', () => {
  it('maps webp to image/webp and everything else to image/jpeg', () => {
    expect(pickPhotoContentType('image/webp')).toBe('image/webp');
    expect(pickPhotoContentType('IMAGE/WEBP')).toBe('image/webp');
    expect(pickPhotoContentType('image/jpeg')).toBe('image/jpeg');
    expect(pickPhotoContentType('image/png')).toBe('image/jpeg');
    expect(pickPhotoContentType('image/heic')).toBe('image/jpeg');
    expect(pickPhotoContentType(undefined)).toBe('image/jpeg');
    expect(pickPhotoContentType(null)).toBe('image/jpeg');
  });
});

describe('assetToSelectedPhoto', () => {
  it('builds a SelectedPhoto from an asset with a uri', () => {
    expect(assetToSelectedPhoto({ uri: 'file:///a.jpg', mimeType: 'image/jpeg' })).toEqual({
      uri: 'file:///a.jpg',
      contentType: 'image/jpeg',
    });
    expect(assetToSelectedPhoto({ uri: 'file:///a.webp', mimeType: 'image/webp' })).toEqual({
      uri: 'file:///a.webp',
      contentType: 'image/webp',
    });
  });

  it('defaults content type to jpeg when the asset omits a mime type', () => {
    expect(assetToSelectedPhoto({ uri: 'file:///a' })).toEqual({
      uri: 'file:///a',
      contentType: 'image/jpeg',
    });
  });

  it('returns null when there is no uri', () => {
    expect(assetToSelectedPhoto(null)).toBeNull();
    expect(assetToSelectedPhoto(undefined)).toBeNull();
    expect(assetToSelectedPhoto({ uri: null, mimeType: 'image/jpeg' })).toBeNull();
    expect(assetToSelectedPhoto({})).toBeNull();
  });
});

describe('selectedPhotoFromResult', () => {
  it('returns null when the picker was canceled', () => {
    expect(selectedPhotoFromResult({ canceled: true, assets: [{ uri: 'file:///a.jpg' }] })).toBeNull();
  });

  it('returns null for a null/empty result', () => {
    expect(selectedPhotoFromResult(null)).toBeNull();
    expect(selectedPhotoFromResult({ canceled: false, assets: [] })).toBeNull();
    expect(selectedPhotoFromResult({ canceled: false, assets: null })).toBeNull();
  });

  it('extracts the first asset from a successful result', () => {
    expect(
      selectedPhotoFromResult({
        canceled: false,
        assets: [{ uri: 'file:///first.jpg', mimeType: 'image/jpeg' }, { uri: 'file:///second.jpg' }],
      }),
    ).toEqual({ uri: 'file:///first.jpg', contentType: 'image/jpeg' });
  });
});

describe('hasComposerContent (chip state)', () => {
  it('is false when everything is empty', () => {
    expect(hasComposerContent({ text: '', waterStatus: null, photo: null })).toBe(false);
    expect(hasComposerContent({ text: '   ', waterStatus: null, photo: null })).toBe(false);
  });

  it('is true when any of text, water, or a photo is present', () => {
    expect(hasComposerContent({ text: 'hi', waterStatus: null, photo: null })).toBe(true);
    expect(hasComposerContent({ text: '', waterStatus: 'flowing', photo: null })).toBe(true);
    expect(
      hasComposerContent({
        text: '',
        waterStatus: null,
        photo: { uri: 'file:///a.jpg', contentType: 'image/jpeg' },
      }),
    ).toBe(true);
  });
});
