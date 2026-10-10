/**
 * Dictionnaire des tags DICOM utiles à l'exploitation d'un dossier patient.
 *
 * `dicom-parser` ne fournit pas de dictionnaire ; on ne retient donc que les
 * tags cliniquement ou méthodologiquement pertinents. Les tags absents de
 * cette table restent accessibles par leur code hexadécimal.
 */
export const DICOM_TAGS: Record<string, string> = {
  // --- Patient ---
  x00100010: 'PatientName',
  x00100020: 'PatientID',
  x00100030: 'PatientBirthDate',
  x00100040: 'PatientSex',
  x00101010: 'PatientAge',
  x00101020: 'PatientSize',
  x00101030: 'PatientWeight',
  x00102000: 'MedicalAlerts',
  x00102110: 'Allergies',
  x00102180: 'Occupation',
  x001021b0: 'AdditionalPatientHistory',
  x00102203: 'PatientSexNeutered',
  x00104000: 'PatientComments',

  // --- Étude ---
  x00080020: 'StudyDate',
  x00080030: 'StudyTime',
  x00080050: 'AccessionNumber',
  x00080060: 'Modality',
  x00080061: 'ModalitiesInStudy',
  x00080070: 'Manufacturer',
  x00080080: 'InstitutionName',
  x00080090: 'ReferringPhysicianName',
  x00081030: 'StudyDescription',
  x00081060: 'NameOfPhysiciansReadingStudy',
  x00081070: 'OperatorsName',
  x00081080: 'AdmittingDiagnosesDescription',
  x0020000d: 'StudyInstanceUID',
  x00200010: 'StudyID',

  // --- Série / instance ---
  x00080021: 'SeriesDate',
  x00080031: 'SeriesTime',
  x0008103e: 'SeriesDescription',
  x0020000e: 'SeriesInstanceUID',
  x00200011: 'SeriesNumber',
  x00080018: 'SOPInstanceUID',
  x00080016: 'SOPClassUID',
  x00200013: 'InstanceNumber',
  x00080008: 'ImageType',
  x00204000: 'ImageComments',
  x00200062: 'ImageLaterality',
  x00082218: 'AnatomicRegionSequence',
  x00180015: 'BodyPartExamined',

  // --- Acquisition ---
  x00180010: 'ContrastBolusAgent',
  x00180020: 'ScanningSequence',
  x00180021: 'SequenceVariant',
  x00180022: 'ScanOptions',
  x00180023: 'MRAcquisitionType',
  x00180024: 'SequenceName',
  x00180050: 'SliceThickness',
  x00180060: 'KVP',
  x00180080: 'RepetitionTime',
  x00180081: 'EchoTime',
  x00180087: 'MagneticFieldStrength',
  x00180088: 'SpacingBetweenSlices',
  x00181030: 'ProtocolName',
  x00181100: 'ReconstructionDiameter',
  x00181150: 'ExposureTime',
  x00181151: 'XRayTubeCurrent',
  x00181152: 'Exposure',
  x00181160: 'FilterType',
  x00181210: 'ConvolutionKernel',
  x00185100: 'PatientPosition',

  // --- Équipement ---
  x00081010: 'StationName',
  x00081040: 'InstitutionalDepartmentName',
  x00081090: 'ManufacturerModelName',
  x00181000: 'DeviceSerialNumber',
  x00181020: 'SoftwareVersions',

  // --- Image ---
  x00280002: 'SamplesPerPixel',
  x00280004: 'PhotometricInterpretation',
  x00280010: 'Rows',
  x00280011: 'Columns',
  x00280030: 'PixelSpacing',
  x00280100: 'BitsAllocated',
  x00281050: 'WindowCenter',
  x00281051: 'WindowWidth',

  // --- Compte rendu structuré (SR) ---
  x0040a043: 'ConceptNameCodeSequence',
  x0040a160: 'TextValue',
  x0040a730: 'ContentSequence',
};

/** Tags contenant du texte libre, injectés dans le corpus interrogeable. */
export const DICOM_NARRATIVE_TAGS = new Set([
  'StudyDescription',
  'SeriesDescription',
  'ImageComments',
  'PatientComments',
  'AdditionalPatientHistory',
  'AdmittingDiagnosesDescription',
  'MedicalAlerts',
  'Allergies',
  'ProtocolName',
  'BodyPartExamined',
  'TextValue',
]);
